/**
 * The hiqlite demo surface (spec 002), operator-gated and demo-scoped
 * (spec 025 §3.1).
 *
 * These endpoints exercise the addon end to end and are the chassis's live
 * proof that in-process hiqlite works. They were also `expose: true` with no
 * `auth: true` and no service middleware, while the hiq service held an
 * UNCONSTRAINED cap.counter.add. Since the rate limiter's bucket key is
 * `rl:<tier>:<client>:<window>` and contains no slash, it fits one path
 * segment: eleven anonymous calls to
 * POST /hiq/counter/rl:auth:<victim>:<window>/add exhausted a chosen client's
 * auth budget and denied it login.
 *
 * Two independent barriers now stand between a stranger and that: the
 * operator role here, and a `demo:` keyPrefix constraint on the grants in
 * app-manifest.json. A regression that drops the annotation below re-exposes
 * a demo keyspace, not the rate limiter.
 */
import { api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";

// The governed facade is the only path to the addon (spec 021 §3.5,
// spec 002 §6); it awaits the raft election internally. Named imports are
// deliberate: the extraction usage walk attributes exact kinds from them.
import {
  counterAdd as hiqCounterAdd,
  counterGet as hiqCounterGet,
  health as hiqHealth,
  kvDel as hiqKvDel,
  kvGet as hiqKvGet,
  kvPut as hiqKvPut,
} from "../kernel/hiq";
import { operatorRole, requireRole } from "../lib/roles";

/**
 * The operator gate for this service. Deliberately not admin/gate.ts's
 * requireOperator: ADMIN_UI_ENABLED is the dashboard's kill switch (spec 023)
 * and has no authority over the addon surface.
 */
function requireHiqOperator(): void {
  requireRole(getAuthData()!, operatorRole());
}

// GET /hiq/health : the addon is loaded and hiqlite is up in-process.
// Public and unauthenticated on purpose: it returns a status string, leaks
// nothing, and is the probe the image smoke curls.
export const health = api(
  { expose: true, method: "GET", path: "/hiq/health" },
  async (): Promise<{ status: string }> => {
    return { status: await hiqHealth() };
  },
);

interface KvPutParams {
  key: string;
  value: string;
  ttlSecs?: number;
}

// POST /hiq/kv : write a value into the embedded cache (optional TTL).
export const kvPut = api(
  { expose: true, auth: true, method: "POST", path: "/hiq/kv" },
  async ({ key, value, ttlSecs }: KvPutParams): Promise<{ ok: true }> => {
    requireHiqOperator();
    await hiqKvPut(key, value, ttlSecs ?? null);
    return { ok: true };
  },
);

interface KvGetResponse {
  key: string;
  value: string | null;
}

// GET /hiq/kv/:key : read a value back through the same in-process client.
export const kvGet = api(
  { expose: true, auth: true, method: "GET", path: "/hiq/kv/:key" },
  async ({ key }: { key: string }): Promise<KvGetResponse> => {
    requireHiqOperator();
    return { key, value: await hiqKvGet(key) };
  },
);

// DELETE /hiq/kv/:key : drop a value (no-op if absent).
export const kvDel = api(
  { expose: true, auth: true, method: "DELETE", path: "/hiq/kv/:key" },
  async ({ key }: { key: string }): Promise<{ ok: true }> => {
    requireHiqOperator();
    await hiqKvDel(key);
    return { ok: true };
  },
);

interface CounterAddParams {
  key: string;
  delta?: number;
}

// POST /hiq/counter/:key/add : atomically add to a replicated counter.
export const counterAdd = api(
  { expose: true, auth: true, method: "POST", path: "/hiq/counter/:key/add" },
  async ({ key, delta }: CounterAddParams): Promise<{ key: string; value: number }> => {
    requireHiqOperator();
    return { key, value: await hiqCounterAdd(key, delta ?? 1) };
  },
);

// GET /hiq/counter/:key : read a counter (null if never set).
export const counterGet = api(
  { expose: true, auth: true, method: "GET", path: "/hiq/counter/:key" },
  async ({ key }: { key: string }): Promise<{ key: string; value: number | null }> => {
    requireHiqOperator();
    return { key, value: await hiqCounterGet(key) };
  },
);
