/**
 * The in-process Prometheus registry (spec 022 §3.1): standard process and
 * runtime metrics plus the HTTP request families and CoreLedger operation
 * counters. Label values are static (service names, endpoint names, status
 * classes, operation verbs), never raw paths or ids: cardinality stays
 * bounded by the app's own shape.
 */
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "API requests handled, by service, endpoint, and status class.",
  labelNames: ["service", "endpoint", "status_class"] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "API request duration in seconds, by service, endpoint, and status class.",
  labelNames: ["service", "endpoint", "status_class"] as const,
  registers: [registry],
});

export const coreledgerOperationsTotal = new Counter({
  name: "coreledger_operations_total",
  help: "CoreLedger driver operations attempted, by operation verb and resource.",
  labelNames: ["operation", "resource"] as const,
  registers: [registry],
});

export const metricsContentType: string = registry.contentType;

export function renderMetrics(): Promise<string> {
  return registry.metrics();
}
