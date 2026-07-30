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
import { afterEach, describe, expect, it } from "vitest";

import { isProcessAlive, lockPath, ownerPath, reclaimStateMachine, type NodeOwner } from "./lock";

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
    host: owner.host ?? hostname(),
    since: owner.since ?? new Date().toISOString(),
  };
  writeFileSync(ownerPath(dir), JSON.stringify(full));
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

afterEach(() => {
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
    expect(owner.host).toBe(hostname());
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

  it("keeps a lock recorded on another host, where a pid means nothing", () => {
    const dir = withOwner(withLock(dataDir()), { pid: deadPid(), host: "some-other-box" });

    const outcome = reclaimStateMachine(dir);

    expect(outcome).toMatchObject({ action: "kept", reason: "foreign-host" });
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
