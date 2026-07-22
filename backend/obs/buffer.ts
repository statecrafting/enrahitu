/**
 * The bounded in-process trace ring buffer (spec 022 §3.2): the substrate
 * has no daemon, so recent traces live where the app itself owns them.
 * Spans arrive as plain DTOs (the tracer converts from OTel's ReadableSpan)
 * grouped by trace id; the oldest trace is evicted once the cap is reached.
 * A trace counts as complete when its root span (no parent) ends, which is
 * when subscribers are notified. This is a recent-window convenience, not a
 * TSDB (spec 022 §5).
 */

export interface BufferedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  startMs: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  status: { code: "unset" | "ok" | "error"; message?: string };
  events: { name: string; timeMs: number }[];
}

export interface BufferedTrace {
  traceId: string;
  spans: BufferedSpan[];
  /** Earliest span start observed for the trace. */
  startMs: number;
  /** Set when the root span ends. */
  endMs?: number;
  rootName?: string;
  /** True if any span in the trace ended with error status. */
  hasError: boolean;
  /** Spans dropped beyond the per-trace guard. */
  droppedSpans: number;
}

export interface TraceSummary {
  traceId: string;
  rootName?: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  spanCount: number;
  hasError: boolean;
}

/** Guard against a single runaway trace displacing the whole window. */
const MAX_SPANS_PER_TRACE = 512;

export class TraceBuffer {
  private readonly traces = new Map<string, BufferedTrace>();
  private readonly subscribers = new Set<(trace: BufferedTrace) => void>();

  constructor(private readonly cap: number) {}

  add(span: BufferedSpan): void {
    let entry = this.traces.get(span.traceId);
    if (!entry) {
      entry = {
        traceId: span.traceId,
        spans: [],
        startMs: span.startMs,
        hasError: false,
        droppedSpans: 0,
      };
      this.traces.set(span.traceId, entry);
      while (this.traces.size > this.cap) {
        const oldest = this.traces.keys().next().value;
        if (oldest === undefined) break;
        this.traces.delete(oldest);
      }
    }
    if (span.startMs < entry.startMs) entry.startMs = span.startMs;
    if (span.status.code === "error") entry.hasError = true;
    if (entry.spans.length >= MAX_SPANS_PER_TRACE) {
      entry.droppedSpans += 1;
    } else {
      entry.spans.push(span);
    }
    if (span.parentSpanId === undefined) {
      entry.rootName = span.name;
      entry.endMs = span.startMs + span.durationMs;
      for (const notify of this.subscribers) {
        try {
          notify(entry);
        } catch {
          // A subscriber must never take the signal plane down.
        }
      }
    }
  }

  /** Most recent traces first (by start time), bounded by `limit`. */
  list(limit = 50): TraceSummary[] {
    const out: TraceSummary[] = [];
    for (const entry of this.traces.values()) {
      out.push({
        traceId: entry.traceId,
        rootName: entry.rootName,
        startMs: entry.startMs,
        endMs: entry.endMs,
        durationMs: entry.endMs === undefined ? undefined : entry.endMs - entry.startMs,
        spanCount: entry.spans.length,
        hasError: entry.hasError,
      });
    }
    out.sort((a, b) => b.startMs - a.startMs);
    return out.slice(0, Math.max(0, limit));
  }

  get(traceId: string): BufferedTrace | undefined {
    return this.traces.get(traceId);
  }

  /** Notified on every completed trace; returns the unsubscribe. */
  subscribe(notify: (trace: BufferedTrace) => void): () => void {
    this.subscribers.add(notify);
    return () => this.subscribers.delete(notify);
  }

  get size(): number {
    return this.traces.size;
  }

  clear(): void {
    this.traces.clear();
  }
}
