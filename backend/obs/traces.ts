/**
 * The internal trace query surface (spec 022 §3.2): list recent traces,
 * fetch one trace's spans, subscribe to completed traces. Plain module
 * exports by design, the same in-process convention as backend/kernel/ and
 * backend/lib/: this is the data plane the spec 023 admin dashboard
 * renders, not a public API, so nothing here is an endpoint.
 */
import type { BufferedTrace, TraceSummary } from "./buffer";
import { traceBuffer } from "./tracer";

export type { BufferedSpan, BufferedTrace, TraceSummary } from "./buffer";

/** Most recent traces first. */
export function listTraces(limit = 50): TraceSummary[] {
  return traceBuffer.list(limit);
}

export function getTrace(traceId: string): BufferedTrace | undefined {
  return traceBuffer.get(traceId);
}

/** Notified on every completed trace; returns the unsubscribe. */
export function onTrace(notify: (trace: BufferedTrace) => void): () => void {
  return traceBuffer.subscribe(notify);
}
