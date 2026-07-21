/**
 * The governed hiqlite facade (spec 021 §3.5): the only importer of the
 * raw addon module (the extraction ban-list enforces this; spec 002 §6).
 * Every kv/counter operation adjudicates its exact kind with the key as
 * attribute, so keyPrefix-constrained grants (the rate limiter's) are
 * enforced for real. init/health stay unadjudicated: they are lifecycle
 * probes, not data operations.
 */
// Import order is load-bearing: the kernel boots (fail-closed) before the
// addon's module-load raft election starts.
import { demand } from "./adjudicate";

import hiqlite, { ready } from "../hiq/init";

export { ready };

export async function health(): Promise<string> {
  await ready;
  return hiqlite.health();
}

export async function kvPut(key: string, value: string, ttlSecs?: number | null): Promise<void> {
  demand("kv.put", "cache", { attributes: { key } });
  await ready;
  return hiqlite.kvPut(key, value, ttlSecs ?? null);
}

export async function kvGet(key: string): Promise<string | null> {
  demand("kv.get", "cache", { attributes: { key } });
  await ready;
  return hiqlite.kvGet(key);
}

export async function kvDel(key: string): Promise<void> {
  demand("kv.delete", "cache", { attributes: { key } });
  await ready;
  return hiqlite.kvDel(key);
}

export async function counterAdd(key: string, delta: number): Promise<number> {
  demand("counter.add", "counters", { attributes: { key } });
  await ready;
  return hiqlite.counterAdd(key, delta);
}

export async function counterGet(key: string): Promise<number | null> {
  demand("counter.get", "counters", { attributes: { key } });
  await ready;
  return hiqlite.counterGet(key);
}

export async function counterSet(key: string, value: number): Promise<void> {
  demand("counter.set", "counters", { attributes: { key } });
  await ready;
  return hiqlite.counterSet(key, value);
}

export async function counterDel(key: string): Promise<void> {
  demand("counter.delete", "counters", { attributes: { key } });
  await ready;
  return hiqlite.counterDel(key);
}
