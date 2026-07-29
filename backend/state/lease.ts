/**
 * The governed lease surface (spec 032 §3.4).
 *
 * **The TTL is ten seconds and is not ours to choose.** hiqlite hardcodes
 * `LOCK_VALID_SECONDS = 10` with no configuration path, so a reconcile running
 * longer than that loses its lease WHILE STILL RUNNING and its replacement
 * begins work concurrently. That is not an edge case to document; it is the
 * normal case for any non-trivial reconcile, and it is why the fencing token is
 * mandatory rather than optional hardening.
 *
 * Enforcement is a SQL predicate at the call site, not addon machinery. Every
 * lease-guarded write carries the token and the store rejects a token below the
 * highest seen for that key:
 *
 * ```sql
 * UPDATE resource SET ..., fence = :token
 *  WHERE id = :id AND fence <= :token
 * ```
 *
 * A zombie holder's writes fail that predicate and it learns it was superseded.
 */
import { demand } from "../kernel/adjudicate";

import hiqlite, { ready } from "../hiq/init";

import { COORD_RESOURCE } from "./types";

/**
 * A held lease: the fencing token plus an explicit release.
 *
 * `release()` is explicit because JavaScript has no deterministic drop. The
 * addon parks the Rust `Lock` in a handle for the same reason: without it the
 * lock would release the instant `lock()` returned and the lease would be a
 * silent no-op rather than a short one.
 */
export interface Lease {
  /**
   * Monotonic per key, and durable: a counter in the SQLITE group, not
   * hiqlite's lock id. Lock state lives in the cache group, which does not
   * survive a full cluster restart, and a fencing token that resets is not a
   * fencing token.
   */
  readonly token: number;
  readonly key: string;
  /** Release the lease. Idempotent; the second call is a no-op. */
  release(): Promise<void>;
}

/**
 * Acquire a lease and its fencing token.
 *
 * Controllers either chunk their work to fit inside ten seconds, or re-acquire
 * and rely on the token. Both are legitimate; pretending the lease is long is
 * not.
 */
export async function lock(key: string): Promise<Lease> {
  demand("lock.acquire", COORD_RESOURCE, { attributes: { key } });
  await ready;
  const held = await hiqlite.lock(key);

  let released = false;
  return {
    token: held.token,
    key: held.key,
    async release(): Promise<void> {
      if (released) return;
      // Re-adjudicated against the same capability and key. The holder
      // necessarily passes, and a service that never held the grant cannot
      // release a peer's lease by naming its key.
      demand("lock.acquire", COORD_RESOURCE, { attributes: { key: held.key } });
      released = true;
      await hiqlite.releaseLock(held.key);
    },
  };
}

/**
 * Run `fn` under a lease, releasing it even if `fn` throws.
 *
 * The token is passed in rather than captured, so the fencing predicate is
 * visible in the callee's SQL instead of being something it has to remember to
 * go and fetch.
 */
export async function withLease<T>(key: string, fn: (token: number) => Promise<T>): Promise<T> {
  const lease = await lock(key);
  try {
    return await fn(lease.token);
  } finally {
    await lease.release();
  }
}
