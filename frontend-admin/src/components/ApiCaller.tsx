import { useState } from "react";

import { callEndpoint, type CallResult, type ModelEndpoint } from "../lib/api";
import { statusTone } from "../lib/format";
import Badge from "./Badge";

const BODYLESS = new Set(["GET", "HEAD", "OPTIONS"]);

/** An inline caller for a single endpoint (spec 023 §3.3 amended): a plain
 * credentialed fetch through lib/api.ts, adjudicated like any other request. */
export default function ApiCaller({ endpoint }: { endpoint: ModelEndpoint }) {
  const [method, setMethod] = useState(endpoint.methods[0] ?? "GET");
  const [path, setPath] = useState(endpoint.path);
  const [body, setBody] = useState("");
  const [result, setResult] = useState<CallResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const canHaveBody = !BODYLESS.has(method.toUpperCase());

  async function call() {
    setPending(true);
    setError(null);
    try {
      const res = await callEndpoint(method, path, canHaveBody ? body : undefined);
      setResult(res);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "request failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="rounded border border-border bg-surface px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {endpoint.methods.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          spellCheck={false}
          className="flex-1 rounded border border-border bg-surface px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <button
          type="button"
          onClick={() => void call()}
          disabled={pending}
          className="shrink-0 rounded bg-accent-soft px-3 py-1 text-xs font-medium text-accent hover:brightness-110 disabled:opacity-50"
        >
          {pending ? "calling..." : "Call"}
        </button>
      </div>

      {canHaveBody ? (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="request body (JSON), optional"
          rows={4}
          spellCheck={false}
          className="w-full rounded border border-border bg-surface px-2 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
      ) : null}

      {error ? <p className="text-xs text-error">{error}</p> : null}

      {result ? (
        <div className="space-y-1.5 rounded border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={statusTone(result.status)}>
              {result.status} {result.statusText}
            </Badge>
            <span className="text-muted">{result.durationMs} ms</span>
            <span className="text-muted">{result.contentType || "no content type"}</span>
          </div>
          <pre className="max-h-80 overflow-auto rounded bg-bg p-2 font-mono text-xs">
            {formatBody(result.body, result.contentType)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function formatBody(body: string, contentType: string): string {
  if (!body) return "(empty body)";
  if (contentType.includes("json")) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  return body;
}
