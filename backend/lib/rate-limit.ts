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

import { counterAdd, counterDel } from "../kernel/hiq";

import { resolveClient } from "./client-identity";
import { logSecurityEvent } from "./logger";
import { bucketKey, windowOrdinal } from "./rate-limit-window";

const API_LIMIT = 100;
const AUTH_LIMIT = 10;

/**
 * The ceiling for the untrusted-identity tier (spec 025 §3.2). Encore's
 * APICallMeta carries headers and no transport peer, so a typed endpoint with
 * no declared proxy has no forge-proof client signal at all. Rather than key
 * on a header a caller controls, this tier keys on the endpoint and enforces
 * one coarse shared ceiling: a limit that cannot be evaded, instead of a
 * per-client limit that can. ENRAHITU_TRUSTED_PROXY_HOPS is the lever that
 * restores the precise tier.
 */
function globalApiLimit(): number {
  const raw = process.env.ENRAHITU_API_GLOBAL_LIMIT;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 2000;
}

/**
 * Atomically increment the fixed-window counter for (tier, key) and return
 * the new count, or null if the backend is unavailable (the caller then
 * fails open).
 */
async function increment(tier: string, key: string): Promise<number | null> {
  try {
    const window = windowOrdinal();
    const count = await counterAdd(bucketKey(tier, key, window), 1);
    if (count === 1) {
      void counterDel(bucketKey(tier, key, window - 1)).catch(() => {});
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

/**
 * General API tier, mounted as service middleware. Two modes, chosen by
 * whether the declared topology vouches for a client identity (spec 025
 * §3.2); the mode is explicit rather than a silent fallback, because a
 * per-client bucket keyed on a forgeable header enforces nothing.
 */
export const apiRateLimit: Middleware = middleware(async (req, next) => {
  const meta = req.requestMeta;
  if (!meta || meta.type !== "api-call") {
    // Not an inbound call (pubsub delivery, internal invocation): one bucket,
    // as before.
    if (!(await withinLimit("api", "internal", API_LIMIT))) {
      throw APIError.resourceExhausted("rate limit exceeded").withDetails({ code: "RATE_LIMITED" });
    }
    return next(req);
  }

  const identity = resolveClient(meta.headers ?? {});
  const ok = identity.trusted
    ? await withinLimit("api", identity.client, API_LIMIT)
    : await withinLimit("api-global", `${meta.api.service}.${meta.api.endpoint}`, globalApiLimit());

  if (!ok) {
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
