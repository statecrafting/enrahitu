/**
 * The governed watch surface (spec 032 §3.2, §3.10).
 *
 * The addon exposes `listenNext()`, one event per call, deliberately: putting a
 * threadsafe-function subscription in Rust would move cancellation and
 * backpressure to the side of the boundary where they are harder to reason
 * about. This module is the other half of that decision, turning one-event-per
 * -call into the `listen(handler)` shape the contract specifies.
 *
 * It runs exactly ONE pump for the process. That is not a convenience: hiqlite's
 * bus delivers each event to a single awaiter, so two concurrent `listenNext()`
 * callers would steal events from each other and each would see an arbitrary
 * half of the stream. Fan-out has to happen on this side.
 *
 * The channel is global rather than per-topic and hiqlite replays cache events
 * after a restart, so handlers filter and must be idempotent. That is not a
 * limitation to work around: notify is a latency hint and a revision watermark
 * is what makes a consumer correct (spec 032 §3.5).
 */
import { demand } from "../kernel/adjudicate";

import hiqlite, { ready } from "../hiq/init";

import { logWarn } from "../lib/logger";

import { COORD_RESOURCE, type Unsubscribe } from "./types";
import type { NotifyEnvelope } from "./types";

export type NotifyHandler = (event: NotifyEnvelope) => void;

const handlers = new Set<NotifyHandler>();
let pumpRunning = false;

/** Back-off between failed `listenNext()` calls, so a downed node cannot spin. */
const PUMP_RETRY_MS = 250;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pump(): Promise<void> {
  pumpRunning = true;
  try {
    while (handlers.size > 0) {
      let event: NotifyEnvelope;
      try {
        event = await hiqlite.listenNext();
      } catch (err) {
        logWarn("state.watch: listenNext failed", { error: String(err) });
        await delay(PUMP_RETRY_MS);
        continue;
      }
      // A throwing handler must not take the pump down with it, and must not
      // prevent its peers from seeing the event.
      for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch (err) {
          logWarn("state.watch: handler threw", { error: String(err) });
        }
      }
    }
  } finally {
    pumpRunning = false;
  }
}

/**
 * Publish a key-only event on the cache raft group.
 *
 * The envelope is a concrete struct, so a caller cannot smuggle a payload onto
 * a group that replicates to every node and is not durable (spec 032 §3.2). The
 * event says a row is worth re-reading; the row is the truth.
 *
 * Issued AFTER the transaction that wrote the row, never inside it: SQL and
 * notify are different raft groups and cannot be atomic with each other, so a
 * notify inside the write path would announce a commit that might not happen.
 */
export async function notify(envelope: NotifyEnvelope): Promise<void> {
  demand("notify.publish", COORD_RESOURCE, { attributes: { topic: envelope.kind } });
  await ready;
  return hiqlite.notify(envelope);
}

/**
 * Register a handler for bus events. Returns an idempotent unsubscribe.
 *
 * Adjudicated once at registration rather than per delivered event: the effect
 * the caller is asking for is "see this stream", and re-adjudicating each event
 * would put a kernel call on a hot path to decide something already decided.
 *
 * One caveat, stated because it is invisible otherwise: when the last handler
 * unsubscribes, the pump is parked inside `listenNext()` and cannot be
 * cancelled, so it consumes and discards exactly one further event before
 * exiting. That is harmless under the watermark rule (a missed notify only
 * delays a poll that would have converged anyway) and would not be under any
 * design that treated delivery as authoritative.
 */
export function listen(handler: NotifyHandler): Unsubscribe {
  demand("notify.listen", COORD_RESOURCE);
  handlers.add(handler);
  if (!pumpRunning) {
    // Start after the node is up; the pump owns its own failures from there.
    void ready.then(() => {
      if (!pumpRunning && handlers.size > 0) void pump();
    });
  }
  return () => {
    handlers.delete(handler);
  };
}

/** Test seam: how many handlers the single pump is currently fanning out to. */
export function listenerCount(): number {
  return handlers.size;
}
