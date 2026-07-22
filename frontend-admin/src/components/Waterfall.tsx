import { useState } from "react";

import type { BufferedSpan, BufferedTrace } from "../lib/api";
import { formatDuration } from "../lib/format";

interface Row {
  span: BufferedSpan;
  depth: number;
}

/** Builds tree rows from parentSpanId: roots first, children sorted by
 * startMs, depth-first (spec 023 §3.4, dashapp's SpanList line). */
function buildRows(spans: BufferedSpan[]): Row[] {
  const ids = new Set(spans.map((s) => s.spanId));
  const byParent = new Map<string | undefined, BufferedSpan[]>();
  for (const span of spans) {
    const parent = span.parentSpanId && ids.has(span.parentSpanId) ? span.parentSpanId : undefined;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(span);
    byParent.set(parent, siblings);
  }
  for (const siblings of byParent.values()) siblings.sort((a, b) => a.startMs - b.startMs);

  const rows: Row[] = [];
  function visit(parent: string | undefined, depth: number) {
    for (const span of byParent.get(parent) ?? []) {
      rows.push({ span, depth });
      visit(span.spanId, depth + 1);
    }
  }
  visit(undefined, 0);
  return rows;
}

export default function Waterfall({ trace }: { trace: BufferedTrace }) {
  const rows = buildRows(trace.spans);
  const [selectedId, setSelectedId] = useState<string | null>(rows[0]?.span.spanId ?? null);

  const start = rows.length > 0 ? Math.min(...rows.map((r) => r.span.startMs)) : trace.startMs;
  const end =
    rows.length > 0
      ? Math.max(...rows.map((r) => r.span.startMs + r.span.durationMs))
      : (trace.endMs ?? trace.startMs);
  const total = Math.max(end - start, 1);

  const selected = rows.find((r) => r.span.spanId === selectedId)?.span ?? null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-base font-semibold">{trace.rootName ?? "(unnamed trace)"}</h1>
        <p className="font-mono text-xs text-muted">{trace.traceId}</p>
        {trace.droppedSpans > 0 ? (
          <p className="mt-1 text-xs text-warn">{trace.droppedSpans} spans dropped</p>
        ) : null}
      </div>

      <div className="space-y-1 rounded-lg border border-border bg-surface p-3">
        {rows.map(({ span, depth }) => {
          const left = ((span.startMs - start) / total) * 100;
          const width = Math.max((span.durationMs / total) * 100, 0.5);
          return (
            <button
              key={span.spanId}
              type="button"
              onClick={() => setSelectedId(span.spanId)}
              style={{ paddingLeft: depth * 14 + 4 }}
              className={`flex w-full items-center gap-2 rounded py-1 pr-1 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                span.spanId === selectedId ? "bg-surface-2" : ""
              }`}
            >
              <span className="w-40 shrink-0 truncate font-mono text-xs">{span.name}</span>
              <span className="relative h-3 flex-1 rounded bg-bg">
                <span
                  className={`absolute h-3 rounded ${span.status.code === "error" ? "bg-error" : "bg-accent"}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-xs text-muted">
                {formatDuration(span.durationMs)}
              </span>
            </button>
          );
        })}
        {rows.length === 0 ? <p className="p-2 text-sm text-muted">no spans buffered</p> : null}
      </div>

      {selected ? (
        <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted">Name</dt>
            <dd className="font-mono">{selected.name}</dd>
            <dt className="text-muted">Kind</dt>
            <dd>{selected.kind}</dd>
            <dt className="text-muted">Duration</dt>
            <dd>{formatDuration(selected.durationMs)}</dd>
            <dt className="text-muted">Status</dt>
            <dd className={selected.status.code === "error" ? "text-error" : ""}>
              {selected.status.code}
              {selected.status.message ? `: ${selected.status.message}` : ""}
            </dd>
          </dl>

          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Attributes</h3>
            {Object.keys(selected.attributes).length === 0 ? (
              <p className="text-xs text-muted">none</p>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {Object.entries(selected.attributes).map(([key, value]) => (
                    <tr key={key} className="border-t border-border">
                      <td className="py-1 pr-3 font-mono text-muted">{key}</td>
                      <td className="py-1 font-mono">{typeof value === "string" ? value : JSON.stringify(value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Events</h3>
            {selected.events.length === 0 ? (
              <p className="text-xs text-muted">none</p>
            ) : (
              <ul className="space-y-0.5 text-xs">
                {selected.events.map((event, i) => (
                  <li key={`${event.name}-${i}`} className="font-mono">
                    {event.name} <span className="text-muted">+{Math.max(event.timeMs - selected.startMs, 0)} ms</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
