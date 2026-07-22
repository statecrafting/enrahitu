/**
 * Observability configuration (spec 022 §3.2): read once at module init.
 * Export is operator-chosen via the standard OTEL_EXPORTER_OTLP_ENDPOINT;
 * unset means no exporter is constructed at all, so the hermetic container
 * gains no phantom network dependency. The trace ring buffer cap is
 * env-tunable with a sane default.
 */
export interface ObsConfig {
  /** OTLP/HTTP collector endpoint; undefined disables export entirely. */
  otlpEndpoint?: string;
  /** Maximum number of traces the ring buffer retains (oldest evicted). */
  traceBufferCap: number;
}

export const DEFAULT_TRACE_BUFFER_CAP = 256;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ObsConfig {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const cap = Number(env.ENRAHITU_TRACE_BUFFER_CAP ?? "");
  return {
    otlpEndpoint: endpoint ? endpoint : undefined,
    traceBufferCap: Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_TRACE_BUFFER_CAP,
  };
}
