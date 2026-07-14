/**
 * Pure fixed-window arithmetic for the rate limiter, separated from
 * lib/rate-limit.ts so it can be unit-tested without loading the hiqlite
 * addon (which starts a raft node as a module side effect via hiq/init.ts).
 */

export const WINDOW_SECONDS = 60;

/** The current window's ordinal (monotonic across processes). */
export function windowOrdinal(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / (WINDOW_SECONDS * 1000));
}

/** Counter key for one (tier, client, window) bucket. */
export function bucketKey(tier: string, clientKey: string, window: number): string {
  return `rl:${tier}:${clientKey}:${window}`;
}
