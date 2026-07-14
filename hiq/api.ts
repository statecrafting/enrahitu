import { api } from "encore.dev/api";

import hiqlite, { ready } from "./init";

// GET /hiq/health : the addon is loaded and hiqlite is up in-process.
export const health = api(
  { expose: true, method: "GET", path: "/hiq/health" },
  async (): Promise<{ status: string }> => {
    await ready;
    return { status: await hiqlite.health() };
  },
);

interface KvPutParams {
  key: string;
  value: string;
  ttlSecs?: number;
}

// POST /hiq/kv : write a value into the embedded cache (optional TTL).
export const kvPut = api(
  { expose: true, method: "POST", path: "/hiq/kv" },
  async ({ key, value, ttlSecs }: KvPutParams): Promise<{ ok: true }> => {
    await ready;
    await hiqlite.kvPut(key, value, ttlSecs ?? null);
    return { ok: true };
  },
);

interface KvGetResponse {
  key: string;
  value: string | null;
}

// GET /hiq/kv/:key : read a value back through the same in-process client.
export const kvGet = api(
  { expose: true, method: "GET", path: "/hiq/kv/:key" },
  async ({ key }: { key: string }): Promise<KvGetResponse> => {
    await ready;
    return { key, value: await hiqlite.kvGet(key) };
  },
);

// DELETE /hiq/kv/:key : drop a value (no-op if absent).
export const kvDel = api(
  { expose: true, method: "DELETE", path: "/hiq/kv/:key" },
  async ({ key }: { key: string }): Promise<{ ok: true }> => {
    await ready;
    await hiqlite.kvDel(key);
    return { ok: true };
  },
);

interface CounterAddParams {
  key: string;
  delta?: number;
}

// POST /hiq/counter/:key/add : atomically add to a replicated counter.
export const counterAdd = api(
  { expose: true, method: "POST", path: "/hiq/counter/:key/add" },
  async ({ key, delta }: CounterAddParams): Promise<{ key: string; value: number }> => {
    await ready;
    return { key, value: await hiqlite.counterAdd(key, delta ?? 1) };
  },
);

// GET /hiq/counter/:key : read a counter (null if never set).
export const counterGet = api(
  { expose: true, method: "GET", path: "/hiq/counter/:key" },
  async ({ key }: { key: string }): Promise<{ key: string; value: number | null }> => {
    await ready;
    return { key, value: await hiqlite.counterGet(key) };
  },
);
