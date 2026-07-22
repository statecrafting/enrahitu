import { useEffect, useState } from "react";
import { useLoaderData } from "react-router";

import Badge from "../components/Badge";
import Waterfall from "../components/Waterfall";
import { fetchTrace, streamTraces, type BufferedTrace, type TraceSummary } from "../lib/api";
import { formatClockTime, formatDuration } from "../lib/format";

const MAX_TRACES = 100;

// The live trace list (spec 023 §3.3/§3.4): the loader seeds recent traces,
// then the SSE stream prepends new ones as ordinary API traffic produces them.
export default function Traces() {
  const initial = useLoaderData<{ traces: TraceSummary[] }>();
  const [traces, setTraces] = useState<TraceSummary[]>(initial.traces);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTrace, setSelectedTrace] = useState<BufferedTrace | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    const close = streamTraces((summary) => {
      setTraces((prev) => {
        const withoutDuplicate = prev.filter((t) => t.traceId !== summary.traceId);
        return [summary, ...withoutDuplicate].slice(0, MAX_TRACES);
      });
    });
    return close;
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setSelectedTrace(null);
      return;
    }
    let cancelled = false;
    setDetailError(null);
    setSelectedTrace(null);
    fetchTrace(selectedId)
      .then(({ trace }) => {
        if (!cancelled) setSelectedTrace(trace);
      })
      .catch((err: unknown) => {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : "failed to load trace");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  return (
    <div className="flex h-full">
      <div className="w-96 shrink-0 overflow-y-auto border-r border-border">
        {traces.length === 0 ? (
          <p className="p-4 text-sm text-muted">no traces yet</p>
        ) : (
          <ul>
            {traces.map((t) => (
              <li key={t.traceId}>
                <button
                  type="button"
                  onClick={() => setSelectedId(t.traceId)}
                  className={`flex w-full flex-col gap-0.5 border-b border-border px-3 py-2 text-left text-xs hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    t.traceId === selectedId ? "bg-surface-2" : ""
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate font-mono">{t.rootName ?? "(unnamed)"}</span>
                    {t.hasError ? <Badge tone="error">error</Badge> : null}
                  </span>
                  <span className="flex gap-2 text-muted">
                    <span>{formatClockTime(t.startMs)}</span>
                    <span>{formatDuration(t.durationMs)}</span>
                    <span>
                      {t.spanCount} span{t.spanCount === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {!selectedId ? (
          <p className="text-sm text-muted">select a trace</p>
        ) : detailError ? (
          <p className="text-sm text-error">{detailError}</p>
        ) : selectedTrace ? (
          <Waterfall key={selectedTrace.traceId} trace={selectedTrace} />
        ) : (
          <p className="text-sm text-muted">loading...</p>
        )}
      </div>
    </div>
  );
}
