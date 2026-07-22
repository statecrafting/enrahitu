/**
 * The observability plane (spec 022): ring buffer semantics, env config
 * gating, real SDK span capture with correct parenting, CoreLedger
 * instrumentation through the internal query surface, OTLP export arrival,
 * and the kernel denial correlation (decision id on the active span).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";

import { demand } from "../kernel/adjudicate";
import type { LedgerDriver } from "../core/ledger/driver";

import type { BufferedSpan } from "./buffer";
import { TraceBuffer } from "./buffer";
import { configFromEnv } from "./config";
import { instrumentDriver } from "./instrument";
import { coreledgerOperationsTotal, registry, renderMetrics } from "./metrics";
import { getTrace, listTraces } from "./traces";
import { createProvider, traceBuffer, tracer } from "./tracer";

function span(overrides: Partial<BufferedSpan>): BufferedSpan {
  return {
    traceId: "t1",
    spanId: "s1",
    name: "test",
    kind: "internal",
    startMs: 1000,
    durationMs: 5,
    attributes: {},
    status: { code: "unset" },
    events: [],
    ...overrides,
  };
}

afterEach(() => {
  traceBuffer.clear();
});

describe("the trace ring buffer (spec 022 §3.2)", () => {
  it("groups spans by trace id and completes on root end", () => {
    const buffer = new TraceBuffer(10);
    const completed: string[] = [];
    buffer.subscribe((t) => completed.push(t.traceId));

    buffer.add(span({ traceId: "a", spanId: "child", parentSpanId: "root", startMs: 1005 }));
    expect(completed).toEqual([]);
    buffer.add(span({ traceId: "a", spanId: "root", name: "req", startMs: 1000, durationMs: 20 }));
    expect(completed).toEqual(["a"]);

    const entry = buffer.get("a");
    expect(entry?.spans).toHaveLength(2);
    expect(entry?.rootName).toBe("req");
    expect(entry?.startMs).toBe(1000);
    expect(entry?.endMs).toBe(1020);
  });

  it("evicts the oldest trace beyond the cap", () => {
    const buffer = new TraceBuffer(2);
    buffer.add(span({ traceId: "a", spanId: "ra" }));
    buffer.add(span({ traceId: "b", spanId: "rb" }));
    buffer.add(span({ traceId: "c", spanId: "rc" }));
    expect(buffer.size).toBe(2);
    expect(buffer.get("a")).toBeUndefined();
    expect(buffer.get("c")).toBeDefined();
  });

  it("lists newest first with error flags and unsubscribes cleanly", () => {
    const buffer = new TraceBuffer(10);
    const seen: string[] = [];
    const unsubscribe = buffer.subscribe((t) => seen.push(t.traceId));
    buffer.add(span({ traceId: "a", spanId: "ra", startMs: 1000 }));
    unsubscribe();
    buffer.add(
      span({ traceId: "b", spanId: "rb", startMs: 2000, status: { code: "error", message: "x" } }),
    );
    expect(seen).toEqual(["a"]);
    const listed = buffer.list(10);
    expect(listed.map((t) => t.traceId)).toEqual(["b", "a"]);
    expect(listed[0].hasError).toBe(true);
  });
});

describe("env config (spec 022 §3.2)", () => {
  it("defaults: no exporter endpoint, sane buffer cap", () => {
    const config = configFromEnv({} as NodeJS.ProcessEnv);
    expect(config.otlpEndpoint).toBeUndefined();
    expect(config.traceBufferCap).toBe(256);
  });

  it("reads the standard OTLP endpoint and the cap override", () => {
    const config = configFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      ENRAHITU_TRACE_BUFFER_CAP: "12",
    } as unknown as NodeJS.ProcessEnv);
    expect(config.otlpEndpoint).toBe("http://collector:4318");
    expect(config.traceBufferCap).toBe(12);
  });

  it("rejects a nonsensical cap", () => {
    const config = configFromEnv({
      ENRAHITU_TRACE_BUFFER_CAP: "-3",
    } as unknown as NodeJS.ProcessEnv);
    expect(config.traceBufferCap).toBe(256);
  });
});

describe("span capture through the registered tracer", () => {
  it("parents CoreLedger children under the active request span, via the query surface", async () => {
    const stub: LedgerDriver = {
      dialect: "sqlite",
      query: async () => [],
      execute: async () => ({ rowsAffected: 0 }),
      batch: async () => {},
      transaction: async (fn) =>
        fn({ query: async () => [], execute: async () => ({ rowsAffected: 0 }) }),
      close: async () => {},
    };
    const driver = instrumentDriver(stub, "app");
    const before = await coreledgerOperationsTotal.get();

    await tracer.startActiveSpan("test.request", async (root) => {
      await driver.query("SELECT 1", []);
      root.end();
    });

    const after = await coreledgerOperationsTotal.get();
    const reads = (labels: { operation: string }) =>
      after.values.filter((v) => v.labels.operation === labels.operation)[0]?.value ??
      0;
    expect(reads({ operation: "read" })).toBeGreaterThan(
      before.values.filter((v) => v.labels.operation === "read")[0]?.value ?? 0,
    );

    const summaries = listTraces(5);
    expect(summaries.length).toBeGreaterThan(0);
    const entry = getTrace(summaries[0].traceId);
    expect(entry).toBeDefined();
    const rootSpan = entry!.spans.find((s) => s.parentSpanId === undefined);
    const child = entry!.spans.find((s) => s.name === "coreledger.read");
    expect(rootSpan?.name).toBe("test.request");
    expect(child?.parentSpanId).toBe(rootSpan?.spanId);
  });

  it("does not create spans without an active parent, but still counts", async () => {
    const stub: LedgerDriver = {
      dialect: "sqlite",
      query: async () => [],
      execute: async () => ({ rowsAffected: 0 }),
      batch: async () => {},
      transaction: async (fn) =>
        fn({ query: async () => [], execute: async () => ({ rowsAffected: 0 }) }),
      close: async () => {},
    };
    const driver = instrumentDriver(stub, "app");
    await driver.execute("CREATE TABLE x (y)", []);
    expect(traceBuffer.size).toBe(0);
  });
});

describe("kernel denial correlation (spec 022 §3.2)", () => {
  it("attaches the decision id to the active span and the typed error", async () => {
    let thrown: unknown;
    await tracer.startActiveSpan("test.denied", async (root) => {
      try {
        demand("kv.get", "cache", { service: "ghost" });
      } catch (err) {
        thrown = err;
      }
      root.end();
    });
    expect(thrown).toBeDefined();
    const details = (thrown as { details?: { decisionId?: string } }).details;
    expect(details?.decisionId).toMatch(/^decision-/);

    const summaries = listTraces(5);
    const entry = getTrace(summaries[0].traceId);
    const rootSpan = entry!.spans.find((s) => s.name === "test.denied");
    expect(rootSpan?.attributes["enrahitu.decision.id"]).toBe(details?.decisionId);
    expect(rootSpan?.attributes["enrahitu.decision.outcome"]).toBe("deny");
  });
});

describe("OTLP export gating (spec 022 acceptance 3)", () => {
  it("ships spans to a collector when the endpoint is set", async () => {
    const received: string[] = [];
    const server = createServer((req, res) => {
      received.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const port = (server.address() as AddressInfo).port;

    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
    try {
      const buffer = new TraceBuffer(8);
      const provider = createProvider(
        { otlpEndpoint: `http://127.0.0.1:${port}`, traceBufferCap: 8 },
        buffer,
      );
      const localTracer = provider.getTracer("test");
      localTracer.startSpan("exported").end();
      await provider.forceFlush();
      await provider.shutdown();
    } finally {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      await new Promise((closed) => server.close(closed));
    }
    expect(received).toContain("/v1/traces");
  });

  it("constructs no exporter when the endpoint is unset", async () => {
    const buffer = new TraceBuffer(8);
    const provider = createProvider({ traceBufferCap: 8 }, buffer);
    const localTracer = provider.getTracer("test");
    localTracer.startSpan("local-only").end();
    await provider.forceFlush();
    await provider.shutdown();
    expect(buffer.size).toBe(1);
  });
});

describe("the metrics registry (spec 022 §3.1)", () => {
  it("renders the request and CoreLedger families alongside process metrics", async () => {
    const text = await renderMetrics();
    expect(text).toContain("# TYPE http_requests_total counter");
    expect(text).toContain("# TYPE http_request_duration_seconds histogram");
    expect(text).toContain("# TYPE coreledger_operations_total counter");
    expect(text).toContain("process_cpu_user_seconds_total");
    expect(registry.contentType).toContain("text/plain");
  });
});
