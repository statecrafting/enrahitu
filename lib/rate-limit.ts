/**
 * Rate limiting on hiqlite counters (in-process, raft-replicated, atomic).
 *
 * Template-encore backed this with a Postgres UNLOGGED table; enrahitu has no
 * Postgres, and this is exactly the workload the hiqlite feasibility report
 * reserved Shape A for. Two fixed-window tiers: a general API tier mounted as
 * service middleware, and a tighter auth tier consumed inline by the
 * login/callback endpoints. On any addon error the limiter fails open
 * (availability over enforcement) and records the event; only a real limit
 * breach is rejected.
 *
 * Window bookkeeping: counters have no TTL, so when a bucket sees its first
 * hit the previous window's bucket for the same (tier, client) is deleted
 * fire-and-forget. An idle client therefore leaks at most one stale counter.
 */
import { APIError, middleware, type Middleware } from "encore.dev/api";

import hiqlite, { ready as hiqReady } from "../hiq/init";

import { logSecurityEvent } from "./logger";
import { bucketKey, windowOrdinal } from "./rate-limit-window";

const API_LIMIT = 100;
const AUTH_LIMIT = 10;

function clientKey(headers: Record<string, string | string[]>): string {
  const xff = headers["x-forwarded-for"];
  const forwarded = Array.isArray(xff) ? xff[0] : xff;
  if (forwarded) return forwarded.split(",")[0]!.trim();
  const real = headers["x-real-ip"];
  return (Array.isArray(real) ? real[0] : real) ?? "anonymous";
}

/**
 * Atomically increment the fixed-window counter for (tier, key) and return
 * the new count, or null if the backend is unavailable (the caller then
 * fails open).
 */
async function increment(tier: string, key: string): Promise<number | null> {
  try {
    await hiqReady;
    const window = windowOrdinal();
    const count = await hiqlite.counterAdd(bucketKey(tier, key, window), 1);
    if (count === 1) {
      void hiqlite.counterDel(bucketKey(tier, key, window - 1)).catch(() => {});
    }
    return count;
  } catch {
    return null;
  }
}

async function withinLimit(tier: string, key: string, limit: number): Promise<boolean> {
  const count = await increment(tier, key);
  if (count === null) {
    // Backend unavailable: fail open so an outage never blocks legitimate traffic.
    logSecurityEvent("ratelimit.backend_error", { tier });
    return true;
  }
  if (count > limit) {
    logSecurityEvent("ratelimit.exceeded", { tier });
    return false;
  }
  return true;
}

/** General API tier, mounted as service middleware. */
export const apiRateLimit: Middleware = middleware(async (req, next) => {
  const meta = req.requestMeta;
  const key = meta && meta.type === "api-call" ? clientKey(meta.headers ?? {}) : "internal";
  if (!(await withinLimit("api", key, API_LIMIT))) {
    throw APIError.resourceExhausted("rate limit exceeded").withDetails({ code: "RATE_LIMITED" });
  }
  return next(req);
});

/**
 * Tighter auth tier, consumed inline by the login/callback raw handlers.
 * Keyed by client IP. Returns false when the caller has exceeded the bucket
 * so the handler can answer 429; fails open on a backend error.
 */
export async function withinAuthRateLimit(clientIp: string | undefined): Promise<boolean> {
  return withinLimit("auth", clientIp ?? "anonymous", AUTH_LIMIT);
}
