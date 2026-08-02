/**
 * Reclaiming a state machine whose previous owner is gone
 * (spec 002, amendment 2026-07-30).
 *
 * hiqlite writes `<data>/state_machine/lock` when the SQLite state machine
 * opens, and removes it in exactly one place: `Client::shutdown()`. The napi
 * addon does not expose `shutdown()` at 0.2.0 and nothing in this application
 * has ever called it, so the lock is never released. Not on SIGTERM, not on a
 * clean `docker compose stop`, and not between the watch loop's rebuilds. The
 * next start then finds it and panics with
 *
 *     Lock file already exists: /data/hiqlite/state_machine/lock
 *     Node did not shut down gracefully - needs manual interaction
 *
 * which is precisely what it says: a human deleting a file inside a container
 * before the store will open again. Under the watch loop that arrives on the
 * *first* edit of a session, because a rebuild stops and restarts the app
 * process; under a restart policy it arrives after any hard kill and survives
 * every subsequent restart. The application stays up either way (spec 036
 * §3.2 keeps a store that will not open from taking down `/healthz` and the
 * login flow with it), so the symptom is a permanently degraded deployment
 * rather than a crash: `/readyz` 500, the membership surface answering 503.
 *
 * ## Why this is not just "delete the lock"
 *
 * The lock is load bearing. Two processes opening one SQLite state machine is
 * corruption, and the panic is the only thing standing between a mistake and
 * that outcome. Deleting it unconditionally at boot would trade a recoverable
 * outage for an unrecoverable one.
 *
 * So the question is not whether to remove the lock but whether it is
 * **provably stale**, and hiqlite's own lock file cannot answer that: it is
 * zero bytes and names no owner. This module supplies the missing half. Every
 * node start records who owns the data directory in `enrahitu-owner.json`
 * (pid, hostname, timestamp) next to it, so a later start can ask whether that
 * owner is still alive:
 *
 * - **no lock**: nothing to reclaim.
 * - **lock, and the recorded owner is a live process in this pid namespace**: a
 *   second node is genuinely starting against a data directory that is in use.
 *   Keep the lock and let hiqlite panic. That panic is correct.
 * - **lock, and the recorded owner is gone**: provably stale. Clear it.
 * - **lock, recorded by a different NODE**: the wrong volume is attached to this
 *   node. Keep the lock and refuse, which is the point of recording the node.
 * - **lock, recorded in a different pid NAMESPACE**: the process tree that held
 *   it no longer exists, so the holder cannot be running. Clear it.
 * - **lock, and no owner record at all**: a volume written before this code
 *   existed, so no live process ever recorded ownership of it. Clear it, once.
 *   Every start from here on leaves a record, so the case does not recur.
 *
 * The owner record is written before `init()` rather than after, so that a
 * node which dies during startup still leaves the evidence its successor needs.
 *
 * ## Why ownership is not keyed on the hostname (amendment 2026-08-02)
 *
 * It was, and that made every container recreate unrecoverable. In docker the
 * hostname IS the container id, so `docker compose up --build`, a `restart`, a
 * rescheduled pod, and any image change all produce a new one. The previous
 * owner's record then looked like it came from a different machine, staleness
 * could not be proven, and the lock was kept forever: the exact outage this
 * module exists to prevent, reached by a path its first version did not
 * consider. It cost seven silent hours of `/readyz` 500 to find.
 *
 * The hostname was standing in for two different questions that it answers
 * badly and that are now asked separately:
 *
 * - **"Is this my data directory?"** answered by `node`, the node's configured
 *   identity (`ENRAHITU_HIQ_NODE_ID`, 1 at N=1, the ordinal at N=3). It comes
 *   from configuration and NOT from the volume, because an identity minted into
 *   the data directory would be read by whoever opened it and would therefore
 *   match by construction, which is a check with no content. Configured, it
 *   catches the failure nothing caught before: node 2 booting against node 1's
 *   volume, which at N=3 is a catastrophic operator error and looked, until
 *   now, exactly like a normal start.
 * - **"Can I interpret that pid?"** answered by `ns`, the pid namespace. A pid
 *   is meaningful only inside the namespace that issued it, and that is the
 *   precise reason the old code wanted a host: not to identify the machine, but
 *   to know whether `kill(pid, 0)` means anything. A namespace that no longer
 *   exists cannot contain a running holder, so the lock is provably stale.
 *
 * What this deliberately does NOT protect against is two live containers
 * mounting one data directory, because the old check did not really protect
 * against it either (it merely refused to decide) and spec 030 §3.4 forbids the
 * topology outright: per-pod PVC, never shared. A guard cannot both permit the
 * recreate that happens constantly and refuse the sharing that must never
 * happen, on evidence this thin, so it is stated rather than pretended.
 *
 * ## What this does not fix
 *
 * Releasing the lock on the way down, which is the actual defect and lives in
 * the addon: it must expose hiqlite's `Client::shutdown()` and this application
 * must call it on SIGTERM. Spec 032's implementation record for 2026-07-30
 * files that as the contract hole it is. Recovery is still needed after that
 * lands, because SIGKILL, the OOM killer, and power loss never call anything.
 */
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/** Who opened this data directory, written next to hiqlite's own lock file. */
export interface NodeOwner {
  pid: number;
  /** The node's configured identity. Absent on records written before 2026-08-02. */
  node?: string;
  /** The pid namespace the pid belongs to, without which the pid means nothing. */
  ns?: string;
  /** Only on records written before 2026-08-02, where the hostname stood in for `ns`. */
  host?: string;
  /** The owner's process start time, which is what makes `pid` unambiguous. */
  start?: string;
  since: string;
}

/**
 * When the process at `pid` started, in clock ticks since boot.
 *
 * This is the field that makes a pid mean something. A pid on its own is a
 * number the kernel reuses, and the reuse is not rare in the case that matters:
 * a recreated container starts counting from the bottom again, so the pid
 * recorded by a previous container is exactly the range a new one hands out
 * within seconds of booting. Measured here, the container that replaced the one
 * holding the lock came up as pid 94.
 *
 * The namespace inode does not settle it either, which is worth recording
 * because it looked like it would: Linux reuses namespace inode numbers, and a
 * forced recreate was observed reporting the identical `pid:[4026533958]` as the
 * container it replaced.
 *
 * Parsed from the end of the `comm` field rather than by splitting the line,
 * because `comm` is the executable name in parentheses and may itself contain
 * spaces and parentheses.
 */
export function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return undefined;
    // Fields after `comm` begin at field 3, so starttime (field 22) is index 19.
    return stat.slice(close + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/**
 * Is the recorded owner still the process running under that pid?
 *
 * Safe by default in both directions it can be wrong: where the start time
 * cannot be read (no procfs, or a legacy record that never stored one) the pid
 * alone decides, which is what the previous version did. It only ever converts
 * "alive" to "gone" on positive evidence that the pid was reused.
 */
function ownerStillRunning(owner: NodeOwner): boolean {
  if (!isProcessAlive(owner.pid)) return false;
  if (owner.start === undefined) return true;
  const current = processStartTime(owner.pid);
  if (current === undefined) return true;
  return current === owner.start;
}

/**
 * Can this process interpret the recorded pid?
 *
 * The two shapes are asked differently on purpose. A current record carries the
 * pid namespace, which is the exact scope a pid is issued in. A legacy record
 * carries only a hostname, and there the OLD comparison is the safe one to
 * keep: equal hostnames meant the pid was interpretable, and on the single boot
 * after an upgrade that is still true and still matters, because the previous
 * process may be mid-shutdown inside the very same container. Normalizing the
 * legacy hostname into the namespace field instead would make it mismatch and
 * clear a lock somebody was still holding, which is the one outcome this whole
 * module exists to avoid.
 */
function interpretableHere(owner: NodeOwner): boolean {
  if (owner.ns !== undefined) return owner.ns === pidNamespace();
  return owner.host === hostname();
}

/**
 * This node's configured identity.
 *
 * Defaults to "1", which is the only voter at N=1 (spec 001: N=1 is the primary
 * mode, not a degenerate case). At N=3 it is the ordinal, and spec 030's
 * `HQL_NODE_ID_FROM=k8s` is where that comes from when it lands.
 */
export function nodeId(): string {
  const configured = process.env.ENRAHITU_HIQ_NODE_ID?.trim();
  return configured ? configured : "1";
}

/**
 * The identity of this process's pid namespace.
 *
 * Linux exposes it as a symlink whose target ("pid:[4026532281]") is stable for
 * every process in the namespace and different in every other one. That is
 * exactly the scope in which a pid can be interpreted, which is the only reason
 * this is recorded.
 *
 * Where there is no procfs (a macOS host running the tests, or the pre-docker
 * dev loop) the hostname is the honest approximation: one namespace per machine.
 */
export function pidNamespace(): string {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return `host:${hostname()}`;
  }
}

export type ReclaimOutcome =
  /** No data directory configured; the addon will pick its own default. */
  | { action: "unconfigured" }
  /** No lock present. Ownership recorded for whoever starts next. */
  | { action: "claimed"; owner: NodeOwner }
  /** A stale lock was removed. */
  | {
      action: "cleared";
      reason: "owner-gone" | "no-owner-record" | "self" | "namespace-gone";
      owner?: NodeOwner;
    }
  /** A lock was left alone: either the holder is alive, or the volume is not ours. */
  | { action: "kept"; reason: "owner-alive" | "foreign-node"; owner: NodeOwner }
  /** The attempt itself failed. hiqlite decides, exactly as it did before. */
  | { action: "failed"; error: string };

/** Where the owner record lives, at the data-dir root so hiqlite never sees it. */
export function ownerPath(dataDir: string): string {
  return join(dataDir, "enrahitu-owner.json");
}

/** hiqlite's zero-byte lock, under the state machine it protects. */
export function lockPath(dataDir: string): string {
  return join(dataDir, "state_machine", "lock");
}

/**
 * Is this pid a running process?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. EPERM means the process is there and simply is not ours to signal,
 * which for this question counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read the owner record, accepting the pre-2026-08-02 shape.
 *
 * A legacy record carries `host` and no `ns`. The hostname is read as the
 * namespace, which is what it was actually standing in for, so a legacy record
 * behaves correctly on both paths: the same container still matches and
 * recovers by pid, and a recreated one no longer matches and recovers as
 * `namespace-gone` instead of being kept forever. `node` stays absent, and an
 * absent node is never treated as foreign, because refusing to boot over a
 * record written before the field existed would turn an upgrade into an outage.
 */
function readOwner(dataDir: string): NodeOwner | undefined {
  try {
    const raw = readFileSync(ownerPath(dataDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { pid, host, ns, node, start, since } = parsed as Record<string, unknown>;
    if (typeof pid !== "number") return undefined;
    // A record with neither is not a record: it cannot answer the only question
    // being asked of it, so it is treated as absent rather than as evidence.
    if (typeof ns !== "string" && typeof host !== "string") return undefined;
    return {
      pid,
      ...(typeof node === "string" ? { node } : {}),
      ...(typeof ns === "string" ? { ns } : {}),
      ...(typeof host === "string" ? { host } : {}),
      ...(typeof start === "string" ? { start } : {}),
      since: typeof since === "string" ? since : "",
    };
  } catch {
    return undefined;
  }
}

function writeOwner(dataDir: string): NodeOwner {
  const start = processStartTime(process.pid);
  const owner: NodeOwner = {
    pid: process.pid,
    node: nodeId(),
    ns: pidNamespace(),
    ...(start === undefined ? {} : { start }),
    since: new Date().toISOString(),
  };
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(ownerPath(dataDir), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  } catch {
    // Best effort. A data directory we cannot write is a problem hiqlite is
    // about to report far more precisely than we could, and refusing to boot
    // over a missing bookkeeping file would be its own outage.
  }
  return owner;
}

/**
 * Clear a provably stale state-machine lock and record this process as the
 * owner. Call once, synchronously, before `hiqlite.init()`.
 *
 * This never throws, and that is a requirement rather than politeness. It runs
 * at module load, so an exception here does not fail a recovery: it fails the
 * import, and takes down a process that would otherwise have started, served
 * `/healthz`, and reported the store's condition (spec 036 §3.2). A read-only
 * volume or a lock owned by another uid would do exactly that through
 * `rmSync`, which honours `force` for a missing file and not for a permission
 * denial. A recovery that cannot run leaves the decision to hiqlite, which is
 * where it sat before this module existed.
 */
export function reclaimStateMachine(
  dataDir: string | undefined = process.env.ENRAHITU_HIQ_DATA_DIR,
): ReclaimOutcome {
  try {
    return decide(dataDir);
  } catch (err) {
    return { action: "failed", error: String(err) };
  }
}

function decide(dataDir: string | undefined): ReclaimOutcome {
  if (!dataDir) return { action: "unconfigured" };

  const lock = lockPath(dataDir);
  if (!existsSync(lock)) return { action: "claimed", owner: writeOwner(dataDir) };

  const owner = readOwner(dataDir);

  if (!owner) {
    rmSync(lock, { force: true });
    writeOwner(dataDir);
    return { action: "cleared", reason: "no-owner-record" };
  }
  // Identity before interpretability. A record from a different node means the
  // wrong volume is attached, and no amount of pid reasoning makes that safe.
  if (owner.node !== undefined && owner.node !== nodeId()) {
    return { action: "kept", reason: "foreign-node", owner };
  }

  // The pid is only meaningful inside the namespace that issued it. A namespace
  // that no longer exists cannot contain a running holder, so this is the one
  // case that is provably stale WITHOUT asking about the pid at all, and it has
  // to be settled before the pid checks rather than after: a recreated container
  // can easily reissue a number the previous one used.
  if (!interpretableHere(owner)) {
    rmSync(lock, { force: true });
    writeOwner(dataDir);
    return { action: "cleared", reason: "namespace-gone", owner };
  }

  if (owner.pid !== process.pid && ownerStillRunning(owner)) {
    return { action: "kept", reason: "owner-alive", owner };
  }

  rmSync(lock, { force: true });
  const reason = owner.pid === process.pid ? "self" : "owner-gone";
  writeOwner(dataDir);
  return { action: "cleared", reason, owner };
}
