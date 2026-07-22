/**
 * The admin API client (spec 023 §3.3): same-origin, cookie-credentialed
 * fetch. 401 means signed out (redirect to login); 403 renders the
 * no-operator state; DTOs mirror backend/admin/api.ts and the spec 022
 * buffer shapes verbatim.
 */

export interface OverviewResponse {
  app: { name: string; org?: string };
  contract: { name: string; version: string };
  model: {
    hash: string;
    gateConfigHash: string;
    revision?: string;
    uncommittedChanges?: boolean;
    producers: { tool: string; version: string; tier: string }[];
  };
  counts: { services: number; endpoints: number; capabilities: number; agents: number };
  observability: { metricsPath?: string; otel?: boolean };
  auth: { idp?: string; operatorRole?: string };
  trust: { levels: string[] };
  gate: { checks: string[] };
  ledger: { records: number; headId?: string; chainVerified: boolean; chainError?: string };
}

export interface ModelEndpoint {
  name: string;
  path: string;
  methods: string[];
  access: string;
  raw?: boolean;
}

export interface ModelService {
  name: string;
  tier: string;
  capabilities: string[];
  endpoints: ModelEndpoint[];
}

export interface CatalogResponse {
  services: ModelService[];
  capabilities: { id: string; kind: string; resource: string }[];
  resources: Record<string, { name?: string; id?: string }[]>;
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
  startMs: number;
  endMs?: number;
  rootName?: string;
  hasError: boolean;
  droppedSpans: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (res.status === 401) {
    window.location.href = "/api/v1/auth/login?redirect=%2Fadmin";
    throw new ApiError(401, "signed out");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body || res.statusText);
  }
  return (await res.json()) as T;
}

export const fetchOverview = () => get<OverviewResponse>("/api/admin/overview");
export const fetchCatalog = () => get<CatalogResponse>("/api/admin/catalog");
export const fetchTraces = (limit = 50) =>
  get<{ traces: TraceSummary[] }>(`/api/admin/traces?limit=${limit}`);
export const fetchTrace = (id: string) =>
  get<{ trace: BufferedTrace }>(`/api/admin/traces/${encodeURIComponent(id)}`);

/** SSE stream of completed traces; returns the close function. */
export function streamTraces(onTrace: (summary: TraceSummary) => void): () => void {
  const source = new EventSource("/api/admin/traces/stream/live");
  source.addEventListener("trace", (event) => {
    onTrace(JSON.parse((event as MessageEvent).data) as TraceSummary);
  });
  return () => source.close();
}

async function csrfToken(): Promise<string> {
  const { token } = await get<{ token: string }>("/api/v1/auth/csrf-token");
  return token;
}

export interface CallResult {
  status: number;
  statusText: string;
  durationMs: number;
  contentType: string;
  body: string;
}

/**
 * The API caller (spec 023 §3.3, amended): a plain credentialed fetch to
 * the target endpoint. The kernel adjudicates it like any request; unsafe
 * methods carry the CSRF double-submit header.
 */
export async function callEndpoint(
  method: string,
  path: string,
  body: string | undefined,
): Promise<CallResult> {
  const headers: Record<string, string> = {};
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  if (unsafe) headers["X-CSRF-Token"] = await csrfToken();
  if (body !== undefined && body !== "") headers["Content-Type"] = "application/json";
  const started = performance.now();
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    body: body === "" ? undefined : body,
  });
  const text = await res.text();
  return {
    status: res.status,
    statusText: res.statusText,
    durationMs: Math.round(performance.now() - started),
    contentType: res.headers.get("content-type") ?? "",
    body: text,
  };
}
