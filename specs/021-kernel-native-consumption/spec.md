---
id: "021-kernel-native-consumption"
title: "Phase A: extraction, kernel-native adjudication, the live Decision ledger"
status: approved
created: "2026-07-20"
implementation: complete
depends_on:
  - "001-enrahitu-architecture"
  - "002-in-process-hiqlite"
  - "003-coreledger"
  - "004-auth-core"
  - "005-rauthy-same-origin"
  - "008-vendored-encore-toolchain"
  - "018-packaged-chassis"
  - "020-app-model-contract"
establishes:
  - "app-manifest.json"
  - "app-model.json"
  - { kind: directory, path: "backend/kernel/" }
summary: >
  Phase A of the enforcement seam (spec 001 section 4.6, item 1 of the
  section 5 sequencing): the substrate consumes
  @statecrafting/kernel-native 0.1.0 (statecrafting spec 004) at the
  existing napi boundary. Three deliverables. Extraction from day one:
  the toolchain drives the vendored tsparser, lowers encore meta plus the
  capability manifest (app-manifest.json, the authored ceiling) into
  app-model.json per spec 020, runs the verify step (observed usage
  subset-of declared, ban-list, sorted arrays, schema-valid), seals the
  gate config hash and the integrity hash, and the committed model is a
  governed derived artifact whose staleness fails the gate. The kernel at
  the napi boundary: boot is fail-closed on the nine refusals and
  write-once per process; the operations that already route through Rust
  (CoreLedger driver calls, hiqlite kv/counters, secret reads, governed
  egress) are adjudicated against the booted model; a deny surfaces as a
  typed error naming the capability. The Decision ledger live: the deploy
  genesis commits to the model hash; denials and human-granted overrides
  append as hash-linked Decisions; the chain re-verifies via the kernel.
  The whole TS tier gets attempt-deny-audit semantics with no new runtime
  machinery. Landing this closes statecrafting spec 004 acceptance item 3
  (the first consumer builds green against the published package).
---

# 021: Phase A: extraction, kernel adjudication, the live Decision ledger

## 1. Purpose

Spec 020 owns the app-model contract; spec 001 section 4.6 phases
enforcement in behind it. This spec is Phase A landing in the substrate:
produce the model inside the app's own build, boot the kernel from it,
adjudicate every operation that already crosses into Rust, and record
denials as ledgered Decisions. No effect-dispatch machinery, no new
runtime tier: the seam is the model, and everything here produces or
consumes that one artifact.

The kernel is not built here. `@statecrafting/kernel-native` 0.1.0
(statecrafting spec 004) is consumed from npm as a regular dependency,
exactly as a stamped app would consume it. Its contract facts this spec
relies on: eight JSON-in / JSON-out functions; boot verifies the model
(the nine refusals, all fail-closed) and is write-once per process (a
second boot with the same model hash is idempotent, a different model is
an error); adjudication is deny-by-default over the declared ceiling;
`gateConfigHash` and `genesisPayload` give a producer the sealing and
verification oracle; v0.1 implements exactly one roster check,
`secrets`, so `gate.checks` pins `["secrets"]` (naming any other check
refuses boot).

## 2. Territory

- `app-manifest.json`: the capability manifest, the authored half of the
  model. The single visible governance surface for a developer: a PR
  reviewer reads a capability-row diff here the way they read a
  Cargo.toml diff.
- `app-model.json`: the committed extracted model, sibling of
  `template.toml` in position and of the manifest in content. Derived,
  never hand-edited; the staleness gate enforces that.
- `backend/kernel/`: the consumption layer over the napi kernel: boot,
  adjudication, the Decision ledger store, the governed egress facade,
  and the governed hiqlite facade.

Amended territory riding this change, each under its owning spec: the
toolchain extract stage (`packages/`, spec 018), the CoreLedger driver
seam (`backend/core/`, spec 003), the hiq facade switch (`backend/hiq/`,
spec 002), secrets/rate-limit/store hooks (`backend/auth/`,
`backend/lib/`, spec 004), the proxied egress and OIDC adjudication
(`backend/idp/`, `backend/auth/rauthy.ts`, spec 005), and the CI
staleness step (`.github/workflows/verify.yml`, spec 010).

## 3. Behavior

### 3.1 The capability manifest

`app-manifest.json` declares what the extractor cannot observe: the
ceiling. Its members mirror the model's shape (spec 020 section 3.2)
minus everything derived:

- `app` `{name, org}`.
- `capabilities`: the grant catalog, `{id, kind, resource,
  constraints?}`, spec 020 vocabulary.
- `services`: per-service `{tier, capabilities}` (refs into the
  catalog), keyed by service name. A service may carry
  `role: "library"`: a service with no endpoints whose modules execute
  only on behalf of importing services (today: `lib`). A library
  service declares no grants; its observed usage is attributed to its
  importers by the verify step, and runtime attribution can never name
  it because it handles no requests.
- `resources`: the declared resource inventory (databases, kv,
  counters, secrets as names only). Secret resource names are the
  lowercase form of the encore secret binding (`jwt_private_key` for
  `JWT_PRIVATE_KEY`): the contract's slug pattern forbids uppercase,
  and the mapping is deterministic in both directions.
- `agents` (empty today), `trust` (the fixed level vocabulary;
  `windowConfig` deliberately omitted in v0.1), `gate.checks`
  (`["secrets"]`), `ledger` policy, `observability`, `auth`.

The manifest is the declared ceiling of fork 3
(declare-verify-enforce): the extractor verifies observed usage against
it, the kernel enforces it, and a change to it is a governance event
that must ride with an authoring edit to this spec (the coupling gate
enforces exactly that, because this spec owns the file).

### 3.2 The extraction pipeline

`enrahitu-extract` (a toolchain bin, spec 018 territory) runs after the
parse stage and implements spec 020 section 3.6 for the TS tier:

1. **Decode.** `.encore/build/meta` is raw protobuf
   (`encore.parser.meta.v1.Data`). The toolchain decodes it with
   protobufjs against the meta/schema proto files it carries (copied
   verbatim from `vendor/encore/proto` at the vendored version; those
   copies remain MPL-2.0 at file level per spec 008, which is
   license-consistent with the toolchain package that already ships
   binaries built from the same tree). The vendored tsparser is not
   patched: spec 008 treats the vendor drop as hermetic.
2. **Lower.** Services and endpoints (name, path, methods, access, raw
   and streaming flags) lower from meta; tier and capability refs join
   from the manifest; resources, trust, gate, ledger, observability,
   auth join from the manifest; `source` is the git identity
   (`revision` = HEAD at extraction, `uncommittedChanges` from status);
   `extraction.producers` = `[{tool: "enrahitu-extract", version:
   <toolchain version>, tier: "ts"}]`. `types` is `[]` in v0.1: the
   contract's opaque escape hatch means type lowering blocks nothing.
3. **Verify** (any failure exits 1, nothing is emitted):
   - schema-valid against `contracts/app-model.schema.json`;
   - cross-references resolve (service capability refs, secret and
     resource names), and the manifest's service set equals meta's;
   - arrays sorted per the schema's `x-sortKey` annotations;
   - **observed subset-of declared**: a transitive import walk from
     each non-library service directory over `backend/` resolves which
     governed facades each service reaches. Named imports map to
     kinds: the hiq facade functions map one-to-one
     (`kvGet` to `kv.get`, `counterAdd` to `counter.add`, and so on);
     the secrets accessors map to `secret.read` of their specific
     secret name; the egress facade maps to `http.egress`; any
     CoreLedger import maps to the `db` family (family-level: per-verb
     static attribution is the named v0.2 extension, matching spec 020
     section 3.4). Every observed touch must be covered by a declared
     grant of the acting service;
   - **ban-list** (the static half of fork 3's honesty clause):
     `@enrahitu/hiqlite-native` imports only in `backend/hiq/init.ts`;
     `hiq/init` imports only in the kernel facade; bare `fetch(` in
     `backend/` only in `backend/kernel/egress.ts`; driver
     construction only in `backend/core/ledger/` and the Decision
     store; `secret(` from encore.dev only in `backend/lib/secrets.ts`.
4. **Seal.** `gate.configHash` =
   `kernelNative.gateConfigHash(checks)`. `integrity.hash` = sha256 of
   the canonical bytes (recursive lexicographic key sort, UTF-8, single
   trailing newline) of the document with `integrity` removed, computed
   in TS. Then the oracle closes the loop across languages:
   `kernelNative.genesisPayload(model)` must verify the sealed document
   and return the same `modelHash`, or the build fails. A model only
   emits if the Rust kernel already accepts it.
5. **Emit.** The file serialization is pretty-printed with recursively
   sorted keys and a trailing newline (PR-reviewable); canonical bytes
   exist only as hash input, and the kernel re-canonicalizes from
   parsed JSON, so file formatting never affects identity. All numbers
   in the model are integers, keeping TS and Rust serializations
   byte-identical.

### 3.3 The committed model and the staleness gate

`app-model.json` is committed at the repo root and is a governed
derived artifact in the spec-spine sense: produced only by the
extractor, coupled to this spec, recomputed by the gate.

`enrahitu-extract --check` recomputes the model and compares it to the
committed file with spec-spine exit-code discipline: 0 ok, 1 verify
violation, 2 stale, 3 I/O or schema error. Two comparison rules keep
the check sound without self-reference:

- The `source` member is held fixed: the committed model records the
  revision it was extracted at (necessarily the parent of the commit
  that updates it); a revision advance alone is not staleness. Any
  other member differing is.
- The committed file must be self-consistent: its `integrity.hash`
  must match recomputation over its own content. A hand-edit to any
  member, including `source`, fails here.

CI runs the check in `verify.yml` after the app build (spec 010's gate
gains the step); the image build needs nothing new, since the packaging
workspace copy already carries the root file.

### 3.4 Kernel boot

`backend/kernel/boot.ts` boots at module evaluation, synchronously:
read `app-model.json` (override: `ENRAHITU_APP_MODEL_PATH`), call
`kernelNative.boot`, hold the receipt. Every governed module imports
the receipt, so no adjudication can precede boot, and the existing
boot promises (`hiq/init.ts`'s `ready`, `auth/store.ts`'s `dbReady`)
sequence behind it by import order. A model that fails any of the nine
refusals (parse, contract range, integrity, dangling refs, unknown
kind, unenforceable constraint, unknown check, gate hash mismatch,
window config) throws at load: the process does not come up. Boot is
write-once: replacing the model means restarting the process, which is
exactly the deploy semantics of a cell.

### 3.5 Adjudication at the Rust-routed seams

`demand(kind, resource, opts)` in `backend/kernel/adjudicate.ts` is the
single enforcement call: it builds the `EffectRequest`, calls
`kernelNative.adjudicate`, and on a deny appends the Decision (3.6) and
throws `APIError.permissionDenied` with details
`{code: "KERNEL_DENIED", reason, capability}` naming the missing
capability (fork 1: kernel internals stay invisible until a deny
happens). Raw handlers translate the same error to a hand-written 403,
matching their existing deny convention.

Acting-service attribution, in precedence order: an explicit service
argument (used by boot-time flows); an ambient `runAsService` scope
(AsyncLocalStorage, used by module-eval side effects such as the auth
schema boot, and available to tests); `currentRequest()` from the
encore runtime (the normal case; auth-handler execution attributes to
`auth`, its home service). No resolvable service is adjudicated as the
literal service `""` and denied by the kernel's unknown-service rule:
unattributable is denied, not excused.

The seams and their kind mapping:

| Site | Kind and resource | Attributes |
|---|---|---|
| CoreLedger driver proxy: the env-selected driver is wrapped before the `Ledger` facade sees it; interactive transactions re-wrap the inner tx | `query` = `db.read`, `execute` = `db.write`, `batch` = `db.migrate`, `transaction` = `db.txn`, resource `app` | none in v0.1 (see below) |
| hiq facade `backend/kernel/hiq.ts`, sole importer of the raw addon | `kv.get/put/delete` on `cache`; `counter.add/get/set/delete` on `counters` | `key` |
| Secrets accessors (`backend/lib/secrets.ts`) | `secret.read` of the specific secret name | none |
| Governed egress `backend/kernel/egress.ts` (used by the idp proxy) | `http.egress` on `rauthy-upstream` | `domain` = target hostname |
| OIDC round-trips (`backend/auth/rauthy.ts`: discovery, code grant) | `http.egress` on `rauthy-issuer` | none (the issuer host is runtime config, never model content) |

Two honesty notes, both named v0.2 extensions. The driver mapping is
mechanical (verb to kind), so DDL run through `execute` during
migrations counts as `db.write`; semantic SQL classification is not
attempted. Table-level constraints are declared ceiling the kernel can
enforce, but the driver seam cannot attribute tables without parsing
SQL, so v0.1 grants on `app` are table-unconstrained; per-table
attribution belongs at the repository layer together with per-handler
attribution (spec 020 section 3.4). The constraint machinery is live
today where attribution is real: rate-limit counter grants carry
`keyPrefix: "rl:"` and every counter call passes its key.

### 3.6 The Decision ledger

`backend/kernel/decisions.ts` owns persistence, exactly the consumer
role statecrafting spec 004 assigns: the kernel stays pure; the store
supplies timestamps, ids, and storage.

- **Store.** One append-only table, `kernel_decisions`
  (`seq, id, timestamp, previous_record_hash, record_hash, payload`),
  on CoreLedger's durable plane through a raw (ungoverned) driver from
  the same env config. The enforcement plane is beneath its own gate
  by construction, not by a runtime bypass flag: the store never
  touches the governed driver, so no recursion exists. Appends are
  serialized in-process; records are built with
  `kernelNative.buildRecord` and re-verified with
  `kernelNative.verifyChain`.
- **Genesis at deploy.** The chain is anchored to the model: the first
  record's `previous_record_hash` is the booted model hash. The record
  builder accepts only `decision/v1` payloads, so the genesis record is
  an `EffectDecision` carrying the `genesisPayload` facts: its
  `modelHash`/`gateConfigHash` are the genesis values, `service` is
  `kernel`, `capability` is `ledger.append` on `*`, `contextHash`
  repeats the model hash, `outcome` is `allow`, and the contract
  version rides the reason as `genesis:<version>`. At boot, an empty
  store appends genesis; a store whose latest genesis names a different
  model hash appends a fresh one, so every deploy boundary is a
  ledgered event. The genesis instance lives only in the ledger,
  never in the model (no circularity, spec 020 section 3.6).
- **Policy.** Every deny appends a Decision (`decision/v1` payload:
  model hash, gate config hash, service, capability, context hash,
  outcome, reason, check ids). Human-granted overrides, when a surface
  for them exists, append with `approver` set: grants as well as
  denials are Decisions. Routine allows do not append; the ledger
  records governance events, not traffic. Denial appends are
  fire-and-forget from the request path (the deny itself is
  synchronous and blocking; its audit record must not add availability
  coupling).
- `ledger.signing` in the model is policy declaration only
  (`ed25519`, key env name); anchor signing is spec 020's named
  extension and no signing happens in v0.1.

### 3.7 Enforcement honesty

Unchanged from fork 3 and spec 001 section 4.6, restated as the
property this spec actually delivers: the TS tier is disciplinary and
auditable, not a sandbox. What Phase A adds is exactly (a) the static
bans at build time, (b) deny plus ledger at the kernel boundary for
everything routed through the facades, (c) secret names in the model
with secret material staying in the runtime config plane. Node still
shares a process with the runtime; a hostile dependency is out of
scope for this tier by design, and handlers whose compromise must be
impossible rather than evident await the Rust tier (Phase B, behind
the same model seam).

### 3.8 The observability member

The model records `observability` as `{metricsPath: "/metrics",
otel: false}` today: the substrate contract (spec 001 section 4.5) is
declared, but the live wiring is item 2 of the section 5 sequencing,
not this spec. When that spec lands it flips `otel` and the model
re-extracts under it. Recording `false` now is deliberate: the model
states what the cell does, not what the roadmap intends.

## 4. Acceptance

1. `enrahitu-extract` emits a schema-valid model the published kernel
   verifies (the genesisPayload oracle), and the committed
   `app-model.json` matches recomputation; `--check` exits 2 on a
   seeded drift and 1 on a seeded ceiling violation.
2. Kernel boot is fail-closed: a tampered committed model (wrong
   integrity, unknown kind, wrong gate hash) refuses to boot the
   process, proven by test against the published package.
3. Deny-and-audit round trip: an operation outside the declared
   ceiling raises the typed `KERNEL_DENIED` error and appends a
   Decision whose chain `verifyChain` accepts and whose genesis
   commits to the booted model hash.
4. The full suite (`npm run typecheck && npm test`) is green against
   `@statecrafting/kernel-native` 0.1.0 from npm on both CoreLedger
   drivers. This is statecrafting spec 004 acceptance item 3's
   consumer condition; the record of it rides in the statecrafting
   corpus per that spec's own instruction.

## 5. Out of scope

- Phase B: the effect-dispatch crate, the Rust handler tier, actor
  mailboxes, cell clustering (spec 001 section 4.6).
- The frontend, admin dashboard, and observability implementation
  specs (spec 001 section 5 item 2), including everything that would
  flip `otel` to true or gate the dashboard on the operator role.
- `template.toml` and spec 009: the model is the sibling of the stamp
  contract, never its replacement; the factory reads `template.toml`
  and nothing else. No slot, verb, or contract-version change rides
  here.
- The app-model contract itself (spec 020 owns schema, determinism,
  versioning) and the kernel itself (statecrafting spec 004 owns the
  package; its chancery donor and re-base are its own section 4).
- Per-handler and per-table attribution, semantic SQL classification,
  windowConfig scoring, and signed anchors: named v0.2 extensions.
- Multi-node operation and the trust ladder's live scoring: no agents
  exist in this cell's model yet; the machinery boots but stays
  dormant until a spec declares an agent.

## Amendment (2026-07-22): the observability seam lands (spec 022)

Spec 022 delivers the wiring §3.8 deferred; four facts here move with it:

- **§3.2 lowering**: `observability.otel` no longer joins from the
  manifest. Toolchain 0.3.0 (statecrafting spec 002 amendment,
  2026-07-22) observes the wiring anchor `backend/obs/tracer.ts` through
  the same import-walk machinery and emits the observed value;
  a new verify rule fails extraction when the manifest declaration
  disagrees. `metricsPath` and every other observability member still
  join from the manifest.
- **§3.6 ids**: denial record ids are generated synchronously
  (time plus entropy, `decision-<ts36>-<hex8>`) before the
  fire-and-forget append, so the request path knows the id it is
  refused under; the seq-derived form remains for genesis and awaited
  appends, and the chain's ordering authority stays the table seq.
  `demand()` announces each denial (with its id) through
  `backend/kernel/observe.ts`, a registrable one-observer hook the
  observability tier subscribes to; the kernel imports nothing from
  `backend/obs/`, and the typed deny's details gain `decisionId`.
- **§3.8**: the model now records `{metricsPath: "/metrics",
  otel: true}`, extracted, exactly as this section promised.
- **The manifest** gains the `obs` service (no capabilities: the signal
  plane demands nothing) and declares `observability.otel: true` to
  match the observation.

## Amendment (2026-07-22b): the admin service joins the manifest (spec 023)

`app-manifest.json` gains the `admin` service with the narrow ceiling
`["cap.secret.jwt-public"]`: the dashboard gate verifies access tokens
(public key only, through the spec 004 jwt-verify split) and demands
nothing else. The model re-extracts under the same pipeline; a stamp
with `admin = "off"` removes the entry at scaffold time (spec 014).

## Amendment (2026-07-23): decision-chain integrity hardens the store (spec 024)

Spec 024 moves four §3.6 facts; `backend/kernel/decisions.ts` (this
spec's territory) carries the change under that spec's design:

- **Ordering authority.** "Appends are serialized in-process" stops
  being the chain's only ordering authority: the store now enforces
  linearity itself (a unique parent index on `prev_hash`; head read
  and insert in one transaction; a lost race reloads the head and
  re-chains; a retry that exhausts fails loud). The in-process queue
  remains as this process's concurrency discipline, no longer the
  integrity guarantee.
- **Boot verification.** Init verifies the persisted chain
  (`kernelNative.verifyChain` plus spec 024's signature pass), and an
  integrity failure on the init path is process-fatal: §3.4's
  fail-closed doctrine extended to the ledger.
- **Denial-append loss.** Fire-and-forget denial appends (§3.6
  policy, unchanged) gain a bracketed, marked loss window: a durable
  dirty flag in `kernel_ledger_meta` and a crash-window marker
  Decision at the next boot.
- **Signing.** "no signing happens in v0.1" retires: spec 024
  activates the declared `ledger.signing` policy consumer-side
  (detached ed25519 over `record_hash` in a sibling column, dormant
  while `ENRAHITU_LEDGER_SIGNING_KEY` is unset). Anchor signing in
  the model stays spec 020's named extension.
