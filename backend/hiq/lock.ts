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
 * - **lock, and the recorded owner is a live process on this host**: a second
 *   node is genuinely starting against a data directory that is in use. Keep
 *   the lock and let hiqlite panic. That panic is correct.
 * - **lock, and the recorded owner is gone**: provably stale. Clear it.
 * - **lock, recorded on a different host**: its pid means nothing in this
 *   namespace, so staleness cannot be proven. Keep the lock.
 * - **lock, and no owner record at all**: a volume written before this code
 *   existed, so no live process ever recorded ownership of it. Clear it, once.
 *   Every start from here on leaves a record, so the case does not recur.
 *
 * The owner record is written before `init()` rather than after, so that a
 * node which dies during startup still leaves the evidence its successor needs.
 *
 * ## What this does not fix
 *
 * Releasing the lock on the way down, which is the actual defect and lives in
 * the addon: it must expose hiqlite's `Client::shutdown()` and this application
 * must call it on SIGTERM. Spec 032's implementation record for 2026-07-30
 * files that as the contract hole it is. Recovery is still needed after that
 * lands, because SIGKILL, the OOM killer, and power loss never call anything.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/** Who opened this data directory, written next to hiqlite's own lock file. */
export interface NodeOwner {
  pid: number;
  host: string;
  since: string;
}

export type ReclaimOutcome =
  /** No data directory configured; the addon will pick its own default. */
  | { action: "unconfigured" }
  /** No lock present. Ownership recorded for whoever starts next. */
  | { action: "claimed"; owner: NodeOwner }
  /** A stale lock was removed. */
  | {
      action: "cleared";
      reason: "owner-gone" | "no-owner-record" | "self";
      owner?: NodeOwner;
    }
  /** A lock was left alone because staleness could not be proven. */
  | { action: "kept"; reason: "owner-alive" | "foreign-host"; owner: NodeOwner }
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

function readOwner(dataDir: string): NodeOwner | undefined {
  try {
    const raw = readFileSync(ownerPath(dataDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { pid, host, since } = parsed as Record<string, unknown>;
    if (typeof pid !== "number" || typeof host !== "string") return undefined;
    return { pid, host, since: typeof since === "string" ? since : "" };
  } catch {
    return undefined;
  }
}

function writeOwner(dataDir: string): NodeOwner {
  const owner: NodeOwner = {
    pid: process.pid,
    host: hostname(),
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
  if (owner.host !== hostname()) {
    return { action: "kept", reason: "foreign-host", owner };
  }
  if (owner.pid !== process.pid && isProcessAlive(owner.pid)) {
    return { action: "kept", reason: "owner-alive", owner };
  }

  rmSync(lock, { force: true });
  const reason = owner.pid === process.pid ? "self" : "owner-gone";
  writeOwner(dataDir);
  return { action: "cleared", reason, owner };
}
