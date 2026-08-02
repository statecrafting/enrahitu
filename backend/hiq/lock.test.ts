/**
 * The stale-lock decision (spec 002, amendment 2026-07-30).
 *
 * These are filesystem tests rather than a booted node on purpose: the whole
 * point of the module is what it decides *before* hiqlite opens anything, and
 * the interesting cases (a dead owner, a live one, a foreign host) are states
 * a real node cannot be talked into producing on demand.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isProcessAlive,
  lockPath,
  nodeId,
  ownerPath,
  pidNamespace,
  processStartTime,
  reclaimStateMachine,
  type NodeOwner,
} from "./lock";

const dirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hiq-lock-"));
  dirs.push(dir);
  return dir;
}

function withLock(dir: string): string {
  mkdirSync(join(dir, "state_machine"), { recursive: true });
  writeFileSync(lockPath(dir), "");
  return dir;
}

function withOwner(dir: string, owner: Partial<NodeOwner>): string {
  const full: NodeOwner = {
    pid: owner.pid ?? process.pid,
    node: owner.node ?? nodeId(),
    ns: owner.ns ?? pidNamespace(),
    // Passed through rather than defaulted: a record with no start time is a
    // real case (legacy, or no procfs) and several tests depend on producing it.
    ...(owner.start === undefined ? {} : { start: owner.start }),
    since: owner.since ?? new Date().toISOString(),
  };
  writeFileSync(ownerPath(dir), JSON.stringify(full));
  return dir;
}

/** An owner record in the pre-2026-08-02 shape: a hostname, and no node or ns. */
function withLegacyOwner(dir: string, owner: { pid: number; host: string }): string {
  writeFileSync(
    ownerPath(dir),
    JSON.stringify({ ...owner, since: new Date().toISOString() }),
  );
  return dir;
}

/**
 * A pid that is certainly not running.
 *
 * Allocated by starting from a high number and walking up until signal 0 says
 * nobody is there, so the test does not depend on a hardcoded pid happening to
 * be free on the machine running it.
 */
function deadPid(): number {
  for (let pid = 4_000_000; pid < 4_000_100; pid++) {
    if (!isProcessAlive(pid)) return pid;
  }
  throw new Error("no free pid found");
}

// `reclaimStateMachine()` falls back to ENRAHITU_HIQ_DATA_DIR, so a suite run
// somewhere that sets it (inside the dev container, say) would point the
// no-data-directory case at a REAL volume and could delete a live node's lock.
// Cleared for the duration rather than worked around in one test, because every
// case here is about a temp directory it was handed explicitly.
let configuredDataDir: string | undefined;
beforeEach(() => {
  configuredDataDir = process.env.ENRAHITU_HIQ_DATA_DIR;
  delete process.env.ENRAHITU_HIQ_DATA_DIR;
});

afterEach(() => {
  if (configuredDataDir === undefined) delete process.env.ENRAHITU_HIQ_DATA_DIR;
  else process.env.ENRAHITU_HIQ_DATA_DIR = configuredDataDir;
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("reclaimStateMachine", () => {
  it("does nothing without a configured data directory", () => {
    expect(reclaimStateMachine(undefined)).toEqual({ action: "unconfigured" });
  });

  it("records ownership on a first boot, when there is no lock to reclaim", () => {
    const dir = dataDir();

    const outcome = reclaimStateMachine(dir);

    expect(outcome.action).toBe("claimed");
    const owner = JSON.parse(readFileSync(ownerPath(dir), "utf8")) as NodeOwner;
    expect(owner.pid).toBe(process.pid);
    expect(owner.node).toBe(nodeId());
    expect(owner.ns).toBe(pidNamespace());
  });

  it("clears a lock whose recorded owner is gone", () => {
    const dir = withOwner(withLock(dataDir()), { pid: deadPid() });

    const outcome = reclaimStateMachine(dir);

    expect(outcome).toMatchObject({ action: "cleared", reason: "owner-gone" });
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it("takes ownership of the directory it just reclaimed", () => {
    const dir = withOwner(withLock(dataDir()), { pid: deadPid() });

    reclaimStateMachine(dir);

    const owner = JSON.parse(readFileSync(ownerPath(dir), "utf8")) as NodeOwner;
    expect(owner.pid).toBe(process.pid);
  });

  it("clears a lock left by a volume that predates any owner record", () => {
    const dir = withLock(dataDir());

    const outcome = reclaimStateMachine(dir);

    expect(outcome).toEqual({ action: "cleared", reason: "no-owner-record" });
    expect(existsSync(lockPath(dir))).toBe(false);
    expect(existsSync(ownerPath(dir))).toBe(true);
  });

  it("clears a lock it recorded against its own pid", () => {
    const dir = withOwner(withLock(dataDir()), { pid: process.pid });

    const outcome = reclaimStateMachine(dir);

    expect(outcome).toMatchObject({ action: "cleared", reason: "self" });
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it("keeps a lock whose owner is still running", () => {
    // pid 1 is running wherever this test runs, and is not this process.
    const dir = withOwner(withLock(dataDir()), { pid: 1 });

    const outcome = reclaimStateMachine(dir);

    expect(outcome).toMatchObject({ action: "kept", reason: "owner-alive" });
    expect(existsSync(lockPath(dir))).toBe(true);
  });

  it("keeps a lock recorded by a DIFFERENT node: the wrong volume is attached", () => {
    // At N=3 this is node 2 booting against node 1's PVC, which is
    // catastrophic and, before the node was recorded, looked like a normal
    // start. A live pid would not make it safe, so identity is checked first.
    const dir = withOwner(withLock(dataDir()), { pid: 1, node: "7" });

    const outcome = reclaimStateMachine(dir);

    expect(outcome).toMatchObject({ action: "kept", reason: "foreign-node" });
    expect(existsSync(lockPath(dir))).toBe(true);
  });

  it("clears a lock recorded in a pid namespace that no longer exists", () => {
    // The regression that cost seven silent hours: in docker the hostname is
    // the container id, so `up --build`, a restart, or a reschedule produced a
    // record the old code called foreign and kept forever. A namespace that is
    // gone cannot hold a running process, so the lock is provably stale.
    const dir = withOwner(withLock(dataDir()), { pid: 1, ns: "pid:[4026000000]" });

    const outcome = reclaimStateMachine(dir);

    expect(outcome).toMatchObject({ action: "cleared", reason: "namespace-gone" });
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it("clears rather than trusts a LIVE pid from a dead namespace", () => {
    // pid 1 is running here, and in a recreated container a low pid is very
    // likely to be reused. Asking about the pid before the namespace would
    // therefore keep the lock on a coincidence.
    const dir = withOwner(withLock(dataDir()), { pid: 1, ns: "pid:[4026000001]" });

    expect(reclaimStateMachine(dir)).toMatchObject({ reason: "namespace-gone" });
  });

  it("recovers a legacy record from a recreated container", () => {
    // Written before the node and ns fields existed. The hostname is read as
    // the namespace, which is what it stood in for, so an upgrade recovers the
    // volume it used to strand instead of needing a human.
    const dir = withLegacyOwner(withLock(dataDir()), { pid: 1, host: "2763aec70bc1" });

    const outcome = reclaimStateMachine(dir);

    expect(outcome).toMatchObject({ action: "cleared", reason: "namespace-gone" });
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it("still honours a legacy record from this same host", () => {
    // The other half: an upgrade must not start clearing locks that a live
    // process on this machine is holding.
    const dir = withLegacyOwner(withLock(dataDir()), { pid: 1, host: hostname() });

    const outcome = reclaimStateMachine(dir);

    expect(outcome).toMatchObject({ action: "kept", reason: "owner-alive" });
    expect(existsSync(lockPath(dir))).toBe(true);
  });

  it("does not overwrite the owner record of a lock it kept", () => {
    const dir = withOwner(withLock(dataDir()), { pid: 1 });

    reclaimStateMachine(dir);

    const owner = JSON.parse(readFileSync(ownerPath(dir), "utf8")) as NodeOwner;
    expect(owner.pid).toBe(1);
  });

  it("reports failure rather than throwing when the lock cannot be removed", () => {
    // A directory where the lock file should be: `rmSync` on it without
    // `recursive` raises EISDIR/EPERM, standing in for the read-only volume
    // and wrong-uid cases that would otherwise throw out of module load.
    const dir = dataDir();
    mkdirSync(lockPath(dir), { recursive: true });

    const outcome = reclaimStateMachine(dir);

    expect(outcome.action).toBe("failed");
  });

  it("treats an unparseable owner record as no record at all", () => {
    const dir = withLock(dataDir());
    writeFileSync(ownerPath(dir), "{ this is not json");

    const outcome = reclaimStateMachine(dir);

    expect(outcome).toEqual({ action: "cleared", reason: "no-owner-record" });
  });
});

describe("isProcessAlive", () => {
  it("recognizes this process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("rejects a pid that is not running", () => {
    expect(isProcessAlive(deadPid())).toBe(false);
  });

  it("rejects values that are not pids", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });
});

describe("pid reuse", () => {
  it("treats a live pid with a different start time as a dead owner", () => {
    // The case that makes a recreated container recoverable in practice. Its
    // pids restart from the bottom, so the number a previous container recorded
    // is exactly the range the new one hands out within seconds: the observed
    // replacement container came up as pid 94. The namespace does not settle it
    // either, having been seen to reuse the identical inode.
    const dir = withOwner(withLock(dataDir()), { pid: 1, start: "1" });

    const outcome = reclaimStateMachine(dir);

    if (processStartTime(1) === undefined) {
      // No procfs (macOS): the pid alone decides, which is the documented
      // fallback rather than a silent pass.
      expect(outcome).toMatchObject({ action: "kept", reason: "owner-alive" });
    } else {
      expect(outcome).toMatchObject({ action: "cleared", reason: "owner-gone" });
      expect(existsSync(lockPath(dir))).toBe(false);
    }
  });

  it("keeps a lock whose owner's start time still matches", () => {
    const start = processStartTime(1);
    const dir = withOwner(withLock(dataDir()), { pid: 1, ...(start ? { start } : {}) });

    expect(reclaimStateMachine(dir)).toMatchObject({ action: "kept", reason: "owner-alive" });
  });

  it("falls back to the pid when no start time was recorded", () => {
    const dir = withOwner(withLock(dataDir()), { pid: 1 });

    expect(reclaimStateMachine(dir)).toMatchObject({ action: "kept", reason: "owner-alive" });
  });

  it("records its own start time where the platform has one", () => {
    const dir = dataDir();
    reclaimStateMachine(dir);
    const owner = JSON.parse(readFileSync(ownerPath(dir), "utf8")) as NodeOwner;
    expect(owner.start).toBe(processStartTime(process.pid));
  });
});
