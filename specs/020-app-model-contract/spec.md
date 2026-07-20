---
id: "020-app-model-contract"
title: "The app-model.json extraction contract"
status: approved
created: "2026-07-19"
implementation: in-progress
depends_on:
  - "001-enrahitu-architecture"
  - "008-vendored-encore-toolchain"
  - "009-template-contract"
establishes:
  - { kind: directory, path: "contracts/" }
summary: >
  The build/run-time contract of a governed cell: one language-neutral
  app-model.json, extracted from source, describing what an app contains
  and what it is permitted to do. One model, two producers (the vendored
  tsparser for the TS tier; the Phase B Rust registry), hash-anchored via
  the family primitives, drift-enforced by the coupling gate, seeding the
  Decision ledger genesis. This spec owns the contract itself: the JSON
  Schema (contracts/app-model.schema.json), the worked example, the
  determinism rules, and the versioning discipline. It absorbs the
  grand-refactor v0.1 draft verbatim as its starting point, completing
  the ownership hand-off that draft names. The model is the sibling of
  template.toml (spec 009), never its replacement: the factory keeps
  reading template.toml and nothing else; the model is produced inside an
  app's own build, after stamping, and is consumed by the kernel, the
  ledger, the coupling gate, and the admin dashboard.
---

# 020: The app-model.json extraction contract

## 1. Purpose

`app-model.json` is the build/run-time contract of a governed cell (spec
001 §4.1): the single extracted description of what an app contains and
what it is permitted to do. It is the first buildable artifact of the
grand refactor, and the seam behind which enforcement phases in (spec
001 §4.6: Phase A produces and consumes it with no new runtime
machinery; Phase B's extractor merges into the same model).

It is the sibling of `template.toml` (spec 009), which is the stamp-time
contract between template and factory. The two never merge: the factory
keeps reading `template.toml` and nothing else; the model is produced
inside an app's own build, after stamping, and is consumed by the
kernel, the ledger, and the governance gates.

Encore's architecture supplies the structural precedent (grounded
against the vendored source, knowledge://grand-refactor/01-grounding-record
§1): a static app model (meta.proto) strictly separated from
environment-specific runtime config (runtime.proto / infra.proto),
joined at load by stable resource names. We keep that split absolutely:

- **In the model:** identity, services, endpoints, resources by name,
  capability declarations, trust assignments, gate configuration, ledger
  policy, type table, extraction record.
- **Never in the model:** credentials, connection strings, hostnames,
  provider choices, environment values, timestamps, absolute paths.

This is what makes the model pure (a function of source + extraction
config only), reproducible, PR-reviewable, and safely publishable.

**Provenance.** This spec absorbs the grand-refactor v0.1 draft
(knowledge://grand-refactor/03-app-model-contract, 2026-07-19) verbatim
as its starting point: the ownership hand-off named in that draft's
preamble. The schema and example were copied unchanged; the prose below
is the draft's, re-homed into this spec's structure. License note: the
schema is our own design; encore's meta.proto informed the shape, but no
proto file is copied (`vendor/encore` is MPL-2.0 at file level, spec
008).

## 2. Territory

- `contracts/app-model.schema.json`: the machine half of the contract
  (JSON Schema 2020-12).
- `contracts/examples/statecraft.app-model.example.json`: a worked
  instance (the downstream consumer's shape, illustrative hashes).

This spec owns the contract: schema, determinism rules, versioning.
It does not own the producers (the toolchain's tsparser lowering and
the Phase B Rust registry), the consumers (kernel-native, the admin
dashboard), or the coupling-gate wiring for committed models; those
belong to the follow-up specs sequenced in spec 001 §5.

## 3. Behavior

### 3.1 Design principles

1. **One model, two producers.** The TS tier's producer is the vendored
   tsparser (already static extraction) driven by the statecrafting
   toolchain, lowered from encore meta plus the manifest. The Rust
   tier's producer is the B1 link-time registry
   (knowledge://grand-refactor/02-realignment, fork 2). A merge step
   unions them and checks cross-tier references. The neutral schema is
   the contract; producers are replaceable behind it.
2. **Declared ceiling, verified emission.** Capability declarations are
   the authoritative ceiling (declare-verify-enforce, 02 fork 3). The
   extractor verifies observed usage is a subset of declarations; a
   model is only emitted if verification passes, so every published
   model is a verified model. Third parties re-verify by recomputing
   (the spec-spine attest discipline: pure function, no key, no clock).
3. **Hash-anchored via the family primitives.** Canonical bytes from
   canonical-keysort-json; sha256 in the attest-ledger style; the
   deploy's ledger genesis record commits to the model hash. The gate's
   `config_hash()` is pinned inside the model, so adjudication config
   is part of the anchored surface.
4. **Deny-by-default.** Any operation kind or resource not named in a
   handler's effective capability set is denied by the kernel and
   ledgered. Absence is never permission.
5. **Semver on the schema itself** (the template.toml discipline, spec
   009 §3.1): `contract.version` versions the schema of this file.
   Additive optional key = minor; changed or removed meaning = major.
   Producers and consumers pin a compatible range. A version bump is an
   edit to `contracts/app-model.schema.json` and rides an authoring
   edit to this spec.
6. **Tier is explicit.** Every service carries `tier: "ts" | "rust"`;
   enforcement semantics derive from it (attempt-deny-audit vs
   cannot-express, spec 001 §4.6). A dedicated enforcement field is a
   named v0.2 candidate if a third mode (e.g. process-isolated TS)
   materializes.

### 3.2 Document tour (top-level members)

| Member | What it is | Provenance |
|---|---|---|
| `contract` | `{name: "app-model", version}` schema self-identification | template.toml §3.1 |
| `app` | `{name, org}` app identity | encore meta / template slots |
| `template` | optional `{name, version, contractVersion}` chassis lineage | template.toml |
| `provenance` | optional `{certificateHash}` bind-by-hash link to the born-with cert (spec 012); never the cert itself | tenant-emit discipline |
| `source` | `{revision, uncommittedChanges}` git identity of the extracted tree | encore `Data.app_revision` |
| `extraction` | producer roster `{tool, version, tier}[]` + `verified: true` | reproducibility record |
| `types` | id-referenced type declaration table; structural or opaque-by-hash | schema.v1 `Decl` table |
| `resources` | what exists, by kind and name: `databases`, `kv`, `counters`, `topics`, `subscriptions`, `buckets`, `secrets` (names only), `crons` | meta.proto resource messages; hiqlite surface |
| `capabilities` | the grant catalog: `{id, kind, resource, constraints}` | generalized `BucketUsage.operations` |
| `services` | services with `tier`, capability refs, and `endpoints[]` (path, methods, access, type refs, streaming flags) | meta.proto `Service`/`RPC`, simplified |
| `agents` | first-class agents: `{name, service, trust, capabilities, entry}` | the governed-cell agent primitive |
| `trust` | ladder vocabulary + window config: levels are trust-window's `Full/Restricted/ReadOnly/Suspended`; `direction` | trust-window |
| `gate` | check roster + `configHash` | action-gate |
| `ledger` | policy only: record schema version, max record bytes, signing algorithm + key env name. Never a genesis instance | attest-ledger; the template.toml provenance rule ("carries the schema, never a cert instance") |
| `observability` | `{metricsPath, otel}` the substrate contract every app exposes | spec 001 §4.5 |
| `auth` | optional `{idp, operatorRole}` | spec 001 §4.4 |
| `integrity` | `{algorithm, hash}` computed per §3.5 | attest-ledger + canonical-keysort-json |

### 3.3 Capability kinds (v0.1 vocabulary)

Grounded in the actual surfaces inventoried during the grand refactor
(the hiqlite Client API, encore's BucketUsage operations, the kernel
faculties):

- `db.read`, `db.write`, `db.txn`, `db.migrate` (CoreLedger)
- `kv.get`, `kv.put`, `kv.delete`; `counter.get`, `counter.add`,
  `counter.set`, `counter.delete`; `lock.acquire`; `notify.publish`,
  `notify.listen` (hiqlite coordination plane)
- `pubsub.publish`, `pubsub.subscribe`
- `bucket.list`, `bucket.read`, `bucket.write`, `bucket.delete`,
  `bucket.sign` (collapsed from encore's nine bucket operations)
- `secret.read`
- `ledger.append`, `ledger.read`, `ledger.verify`
- `endpoint.call` (service-to-service)
- `http.egress` (governed fetch; `constraints.domains` required)
- `tool.invoke` (agent tools)

`constraints` is a kind-specific object (well-known keys in v0.1:
`tables`, `keyPrefix`, `domains`, `topics`, `tools`); per-kind
constraint schemas harden in a minor revision as usage accumulates.

### 3.4 Granularity (inherited limitation, named plan)

v0.1 capability refs attach per-service, matching what tsparser can
attribute reliably today (its usage attribution is service/package
level, knowledge://grand-refactor/01-grounding-record §1);
`endpoints[].capabilities` exists as optional narrowing. Per-handler
attribution as the verified default is the flagged v0.2 extension of
the usage parser.

### 3.5 Determinism rules

The model MUST be a pure function of (source tree, extraction config,
producer versions). Mechanically:

1. **No wall clock, no environment.** Timestamps, hostnames, usernames,
   absolute paths are forbidden everywhere. Git revision is the only
   temporal anchor (attest-ledger passes timestamps in for the same
   reason).
2. **Canonical serialization.** Canonical bytes are
   `canonical-keysort-json::to_canonical_string` output (recursive
   lexicographic key sort), UTF-8, single trailing newline.
3. **Array ordering is the producer's contract.** canonical-keysort-json
   sorts keys only, so the schema annotates every array with
   `x-sortKey` (e.g. services by `name`, capabilities by `id`, types by
   `id`, producers by `tool`; plain string arrays lexicographic).
   Arrays that are semantically ordered (migrations by `number`, path
   segments in path order) are marked `x-ordered: semantic`. Producers
   MUST emit sorted; verifiers MUST reject unsorted.
4. **Integrity.** `integrity.hash` = `"sha256:" + sha256_hex(canonical
   bytes of the document with the integrity member removed)`.
   `integrity.algorithm` = `"sha256-canonical-keysort-v1"`.

### 3.6 The pipeline

```
manifest (declared)      source (implementation)
        \                     /
   extract per tier: tsparser lowering (ts) + B1 registry (rust)
        \                     /
         merge: union, resolve cross-tier refs
         verify: observed subset-of declared; ban-list; schema-valid
         canonicalize -> hash -> emit app-model.json
```

Exit-code discipline follows spec-spine: 0 ok, 1 violation (drift,
subset failure, dangling ref), 2 stale (committed model does not match
recomputation), 3 I/O / parse / schema error.

**Consumers:**

- **Kernel boot** (`@statecrafting/kernel-native`): loads the model,
  builds the per-service enforcement tables, refuses to start on
  integrity mismatch.
- **Ledger genesis:** the deploy constructs the first Decision record's
  payload from the model (`{modelHash, gateConfigHash,
  contractVersion}`). The genesis instance lives only in the ledger,
  never in the model: no circularity.
- **Coupling gate:** the committed model is a governed derived artifact
  in the spec-spine sense; manifest changes must ride with their owning
  spec, and the recompute check makes a stale committed model exit 2.
- **Admin dashboard** (`frontend-admin`): renders the governed surface
  (services, rows, trust, ledger head) from the model, read-only.
- **Explicitly not a consumer: the factory.** The factory reads
  `template.toml` and nothing else; the model is born inside the
  stamped app's own build. The fleet MAY record the model hash as
  placement metadata, but never parses the model's interior.

### 3.7 Drift semantics

- **Build time:** verify failure (usage outside the declared ceiling,
  dangling capability/type/resource ref, unsorted arrays, schema
  violation) fails the build. Exit 1.
- **PR time:** the coupling gate flags a capability-manifest change that
  does not ride with its owning spec edit, and a committed model that no
  longer matches recomputation. Exit 1 / 2.
- **Runtime:** the kernel denies any operation outside the model's
  effective capability set and appends the denial as a Decision. A
  model whose integrity hash fails at boot is a refusal to start, not a
  warning.

## 4. Named extensions (not in v0.1)

- Per-handler capability attribution as the verified default (v0.2).
- Per-kind constraint schemas (progressive minor bumps).
- Full structural type lowering for both tiers; v0.1 producers MAY emit
  `opaque: true` types carrying only a content hash, so the contract
  does not block on a complete TS-to-neutral type compiler.
- An `enforcement` field decoupled from `tier` (only if a third mode
  materializes).
- Signed model anchors (attest-ledger `build_anchor_with_key`) for
  distribution beyond the deploy boundary.

## 5. Out of scope

- The producers: the toolchain's lowering stage and verify step, and
  the Phase B Rust registry (follow-up specs, spec 001 §5).
- The consumers: kernel-native, the Decision ledger runtime, the admin
  dashboard (follow-up specs).
- `template.toml` and stamp-time semantics (spec 009; the factory never
  reads the model).
- The born-with certificate itself (spec 012; the model carries only an
  optional bind-by-hash reference).
- Enrahitu's own committed model instance and its coupling-gate wiring:
  they arrive with the Phase A extraction implementation, not with this
  contract.
