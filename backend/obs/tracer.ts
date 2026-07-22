/**
 * The OTel tracer wiring (spec 022 §3.2), and the file the extractor treats
 * as the wiring anchor: a service that transitively imports this module is
 * instrumented, which is what flips the model's observability.otel to true
 * (toolchain 0.3.0, statecrafting spec 002 amendment 2026-07-22).
 *
 * Two span sinks, independent by design: the bounded in-process ring buffer
 * is always on (the substrate has no daemon, so the app is its own trace
 * sink); the OTLP exporter exists only when OTEL_EXPORTER_OTLP_ENDPOINT is
 * set. Kernel denials attach their Decision id to the active span through
 * the kernel's observer hook, so a trace and its ledger record correlate.
 */
import { SpanKind, trace } from "@opentelemetry/api";
import type { HrTime } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import { modelJson } from "../kernel/boot";
import { setDenialObserver } from "../kernel/observe";

import type { BufferedSpan } from "./buffer";
import { TraceBuffer } from "./buffer";
import type { ObsConfig } from "./config";
import { configFromEnv } from "./config";

function hrToMs(time: HrTime): number {
  return time[0] * 1_000 + time[1] / 1_000_000;
}

const STATUS_CODES = ["unset", "ok", "error"] as const;

export function toBufferedSpan(span: ReadableSpan): BufferedSpan {
  const context = span.spanContext();
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    name: span.name,
    kind: SpanKind[span.kind].toLowerCase(),
    startMs: hrToMs(span.startTime),
    durationMs: hrToMs(span.duration),
    attributes: { ...span.attributes },
    status: {
      code: STATUS_CODES[span.status.code] ?? "unset",
      message: span.status.message,
    },
    events: span.events.map((event) => ({ name: event.name, timeMs: hrToMs(event.time) })),
  };
}

class BufferSpanProcessor implements SpanProcessor {
  constructor(private readonly buffer: TraceBuffer) {}
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    this.buffer.add(toBufferedSpan(span));
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Build a provider for the given config. The OTLP exporter is constructed
 * only when the endpoint is set: unset means no exporter object exists and
 * no connection is ever attempted (spec 022 acceptance 3).
 */
export function createProvider(config: ObsConfig, buffer: TraceBuffer): NodeTracerProvider {
  const spanProcessors: SpanProcessor[] = [new BufferSpanProcessor(buffer)];
  if (config.otlpEndpoint !== undefined) {
    spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  }
  const appName =
    (JSON.parse(modelJson) as { app?: { name?: string } }).app?.name ?? "enrahitu";
  return new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: appName }),
    spanProcessors,
  });
}

const config = configFromEnv();

/** The app's trace ring buffer; queried through traces.ts (spec 023 renders it). */
export const traceBuffer = new TraceBuffer(config.traceBufferCap);

const provider = createProvider(config, traceBuffer);
provider.register();

export const tracer = trace.getTracer("enrahitu-obs");

setDenialObserver((denial) => {
  const span = trace.getActiveSpan();
  if (span === undefined || !span.isRecording()) return;
  span.setAttributes({
    "enrahitu.decision.id": denial.decisionId,
    "enrahitu.decision.outcome": denial.outcome,
    "enrahitu.decision.capability": `${denial.capability.kind}:${denial.capability.resource}`,
    "enrahitu.decision.reason": denial.reason,
  });
});
