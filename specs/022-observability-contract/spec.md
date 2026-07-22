---
id: "022-observability-contract"
title: "The observability contract: /metrics + OTel, in the substrate"
status: approved
created: "2026-07-21"
implementation: complete
depends_on:
  - "001-enrahitu-architecture"
  - "008-vendored-encore-toolchain"
  - "019-two-directory-layout"
  - "021-kernel-native-consumption"
establishes:
  - { kind: directory, path: "backend/obs/" }
summary: >
  Builds the observability contract that spec 001 section 4.5 declares
  and spec 021 section 3.8 deliberately deferred: every enrahitu app
  exposes a Prometheus /metrics endpoint and OTel traces as a
  non-negotiable substrate capability, recorded truthfully in
  app-model.json (observability.otel flips to true). The substrate has
  no Encore daemon (spec 008 vendored the toolchain without the CLI),
  so traces must live somewhere the app itself owns: alongside the
  OTLP exporter (off by default, env-configured) the app keeps a
  bounded in-process trace buffer that downstream surfaces (the spec
  023 admin dashboard) query same-origin. The contract deliberately
  stops at the signals: what scrapes /metrics or receives OTLP is the
  operator's choice per cell, never a template stack choice.
---

# 022: The observability contract

## 1. Purpose

Spec 001 §4.5 makes the promise: every enrahitu app (a platform, a
stamped tenant app) exposes the standard signals, a Prometheus
`/metrics` endpoint and OTel traces, and the app model records it.
Spec 021 §3.8 shipped the model member as `{metricsPath: "/metrics",
otel: false}` and named this spec as the one that flips it. Nothing in
`backend/` currently emits a metric or a span.

The constraint that shapes the design: there is no daemon. Encore's
own dev dashboard gets traces from the `encore` daemon process; spec
008 vendored the toolchain precisely without that CLI. So the
substrate must be its own trace sink for local/in-app consumption,
with OTLP export as the operator-facing escape hatch.

## 2. Territory

- `backend/obs/` (new service directory, nested inside the backend
  the way `kernel/` is): metrics registry + `/metrics` endpoint,
  tracer initialization, the trace ring buffer, and the internal
  query surface consumed by spec 023.
- Coordinated edits, each paired with a dated pointer amendment in
  the owning spec: instrumentation touch points in chassis plumbing
  (spec 019 layout, spec 004 auth middleware ordering if needed),
  `app-model.json` / `app-manifest.json` (spec 021) and the extractor
  (spec 020) so `observability.otel: true` is extracted, not
  hand-edited.

## 3. Behavior

### 3.1 Metrics

- `GET /metrics` serves Prometheus text format from an in-process
  registry: standard process/runtime metrics plus HTTP request
  counters and duration histograms labeled by service, endpoint, and
  status class. CoreLedger operation counters ride the same registry.
- The endpoint is part of the app, always on (the contract is
  non-negotiable; there is no flag), and unauthenticated at the app
  layer: deployment guidance (the platform's spec 010/012 line, a
  stamped app's operator docs) keeps it off the public ingress.
  Cardinality discipline: labels are static path patterns, never raw
  paths or ids.

### 3.2 Traces

- An OTel tracer runs in-process: spans for every API request
  (service, endpoint, status, duration) and for CoreLedger operations;
  kernel Decisions (spec 021) attach their decision id as a span
  attribute so a trace and its ledger record can be correlated.
- Export is operator-chosen: when `OTEL_EXPORTER_OTLP_ENDPOINT` is
  set, spans ship OTLP; unset means no exporter (no phantom network
  dependency in the hermetic container).
- Independent of export, the app retains a bounded ring buffer of
  recent traces (env-tunable cap, sane default, oldest evicted) and
  `backend/obs/` exposes an internal query surface: list recent
  traces, fetch one trace's spans, subscribe to new traces. This is
  the data plane the spec 023 dashboard renders; it is not a public
  API.

### 3.3 The model tells the truth

- `observability` in the extracted model reports
  `{metricsPath: "/metrics", otel: true}` because the extractor
  observes the wiring, not because anyone edited JSON. The golden
  fixtures and hash anchors regenerate through the sanctioned
  pipeline; a hand-edited model still fails the coupling gate.

### 3.4 Implementation notes (2026-07-22)

Design points fixed at implementation time, recorded so the prose above
reads precisely:

- **Decision correlation mechanism.** Denial record ids are generated
  synchronously in the store before the fire-and-forget append (ids are
  the store's to supply, spec 021 §3.6), and the kernel announces the
  denial through a registrable observer hook (`backend/kernel/observe.ts`)
  that the tracer subscribes to: the enforcement plane imports nothing
  from `backend/obs/`, and the active span gains
  `enrahitu.decision.id`/`outcome`/`capability`/`reason`. The typed
  `KERNEL_DENIED` error carries `decisionId` too.
- **The query surface is a module, not an API.** `backend/obs/traces.ts`
  exports `listTraces`/`getTrace`/`onTrace` as plain in-process functions,
  the same convention as `backend/kernel/` and `backend/lib/`: nothing to
  expose, nothing to gate, and spec 023's admin service imports it
  directly.
- **The OTLP exporter's egress sits outside the kernel egress facade.**
  Operator-enabled infrastructure telemetry configured by env is not
  app-tier behavior; the ban-list governs `backend/` source, and no
  `backend/` code performs the export I/O itself.
- **The web static service is not instrumented.** Static asset serving is
  not an API request; `web` keeps its no-middleware posture (spec 006
  caching), and `obs` does not measure itself (a scrape must not fill the
  buffer with self-observation).
- **Extraction semantics.** The observed flip is toolchain 0.3.0
  (statecrafting spec 002 amendment, 2026-07-22): `otel` is observed from
  the wiring anchor `backend/obs/tracer.ts`, and the manifest's
  declaration must agree with the observation or extraction fails.

## 4. Acceptance

1. `curl :4000/metrics` returns Prometheus text format including at
   least the HTTP request counter and duration histogram families,
   and the counters move when API requests are made.
2. Making an API request produces a trace observable through the
   internal query surface with correctly parented spans (request span
   plus at least one CoreLedger child where applicable).
3. With `OTEL_EXPORTER_OTLP_ENDPOINT` pointed at a collector, spans
   arrive there; with it unset, the app makes no exporter connection
   attempts.
4. `app-model.json` reports `observability.otel: true` via extraction;
   the kernel's fail-closed boot check still refuses a mutated model.
5. Template verify verbs (`npm run typecheck && npm test`) and the
   spec-spine gates stay green; the packaged image (spec 007/016)
   serves `/metrics` identically.

## 5. Out of scope

- Rendering: dashboards, charts, the admin UI (spec 023).
- Alerting, log aggregation, and long-term trace storage; the buffer
  is a recent-window convenience, not a TSDB.
- Any change to what scrapes the signals: Prometheus, collectors, and
  cloud tools remain per-cell operator choices (spec 001 §4.5).
