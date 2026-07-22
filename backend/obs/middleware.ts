/**
 * The HTTP observation middleware (spec 022 §3.1-3.2): one request span
 * plus the counter/histogram families per handled API request. Mounted
 * outermost on the instrumented services (auth, health, hiq, idp) so inner
 * middleware work and denials are measured too. The web static service and
 * obs itself are deliberately not instrumented: static asset serving is not
 * an API request, and a scrape must not observe itself.
 *
 * Label discipline: service and endpoint names come from the runtime's
 * request metadata (static identifiers, never raw paths); the span carries
 * the model's path pattern as http.route.
 */
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import { currentRequest } from "encore.dev";
import { APIError, middleware } from "encore.dev/api";

import { modelJson } from "../kernel/boot";

import { httpRequestDurationSeconds, httpRequestsTotal } from "./metrics";
import { tracer } from "./tracer";

/** Encore error codes to HTTP statuses (encore.dev/api ErrCode wire mapping). */
const STATUS_BY_ERR_CODE: Record<string, number> = {
  canceled: 499,
  unknown: 500,
  invalid_argument: 400,
  deadline_exceeded: 504,
  not_found: 404,
  already_exists: 409,
  permission_denied: 403,
  resource_exhausted: 429,
  failed_precondition: 400,
  aborted: 409,
  out_of_range: 400,
  unimplemented: 501,
  internal: 500,
  unavailable: 503,
  data_loss: 500,
  unauthenticated: 401,
};

function statusFromError(err: unknown): number {
  if (err instanceof APIError) return STATUS_BY_ERR_CODE[String(err.code)] ?? 500;
  return 500;
}

/** service -> endpoint -> path pattern, from the booted model (static labels). */
const routePatterns: Map<string, string> = (() => {
  const model = JSON.parse(modelJson) as {
    services?: { name: string; endpoints?: { name: string; path: string }[] }[];
  };
  const patterns = new Map<string, string>();
  for (const service of model.services ?? []) {
    for (const endpoint of service.endpoints ?? []) {
      patterns.set(`${service.name}.${endpoint.name}`, endpoint.path);
    }
  }
  return patterns;
})();

export const obsMiddleware = middleware(async (req, next) => {
  const meta = currentRequest();
  if (meta?.type !== "api-call") return next(req);
  const service = meta.api.service;
  const endpoint = meta.api.endpoint;
  const qualified = `${service}.${endpoint}`;
  const started = process.hrtime.bigint();

  return tracer.startActiveSpan(
    qualified,
    {
      kind: SpanKind.SERVER,
      attributes: {
        "enrahitu.service": service,
        "enrahitu.endpoint": endpoint,
        "http.request.method": meta.method,
        "http.route": routePatterns.get(qualified) ?? "",
      },
    },
    async (span: Span) => {
      // Known limitation: typed handlers expose no status getter on their
      // HandlerResponse, so a typed endpoint overriding its success status
      // would still label 2xx here. No typed endpoint does that today; raw
      // endpoints report their real status via rawResponse.
      let statusCode = 200;
      try {
        const resp = await next(req);
        statusCode = req.rawResponse?.statusCode ?? 200;
        return resp;
      } catch (err) {
        statusCode = statusFromError(err);
        if (err instanceof Error) span.recordException(err);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        const labels = {
          service,
          endpoint,
          status_class: `${Math.floor(statusCode / 100)}xx`,
        };
        httpRequestsTotal.inc(labels);
        httpRequestDurationSeconds.observe(labels, seconds);
        span.setAttribute("http.response.status_code", statusCode);
        span.end();
      }
    },
  );
});
