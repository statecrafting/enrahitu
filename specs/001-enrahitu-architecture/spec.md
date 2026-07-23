---
id: "001-enrahitu-architecture"
title: "enrahitu: the self-contained governed cell substrate"
status: approved
created: "2026-07-14"
implementation: in-progress
origin:
  retroactive: true   # shell units back-written from docs/ARCHITECTURE.md; thesis rewritten ground-up 2026-07-19
depends_on:
  - "000-bootstrap"
establishes:
  - { kind: directory, path: "backend/health/" }
  - "encore.app"
  - "tsconfig.json"
  - "vitest.config.ts"
  - "vitest.setup.ts"
summary: >
  The architecture thesis and the app shell, rewritten ground-up on
  2026-07-19 from the grand-refactor realignment. enrahitu is the
  substrate for governed cells: Encore.ts is kept as the application
  framework while its managed-infrastructure coupling stays severed
  (in-process hiqlite, CoreLedger on libSQL/Turso, rauthy inside the app
  image), and every app built on it is a self-contained governed cell
  carrying embedded identity, embedded consensus, durable state behind
  one decorator data layer, a non-negotiable observability contract
  (Prometheus /metrics + OTel), and one extracted, hash-anchored model
  (app-model.json, spec 020) of what it contains and what it is
  permitted to do. The frontend converges React-only: frontend (the
  user-facing SPA) plus frontend-admin (the flag-gated admin dashboard,
  gated on the <app>_operator role convention). Enforcement phases in
  behind the model (Phase A: extraction, kernel adjudication, Decision
  ledger; Phase B: the Rust effect tier). One Docker image plus one
  volume is a complete authenticated, observable, governed application.
  This spec owns the repo-shell units (Encore app manifest, TypeScript
  and test configuration, the health service) and anchors the root
  package; subsystems are governed by specs 002-019 and the follow-up
  specs this rewrite sequences. This repository is enrahitu (EnRaHiTu:
  Encore.ts + rauthy + hiqlite + Turso; formerly enrahi / enrahi-kit):
  the Encore toolchain is vendored and driven directly via napi-rs
  (spec 008), and the repo doubles as the template chassis the
  Statecraft factory stamps (spec 009).
---

# 001: enrahitu architecture

## 1. Purpose

Encore.ts is an excellent application framework, but its business model
monetizes cloud provisioning, so its primitives (notably `SQLDatabase`)
couple application code to managed infrastructure. enrahitu keeps the
framework and severs the coupling:

- **hiqlite, in-process** (napi-rs addon, spec 002): cache/KV, counters
  (rate limiting), and coordination; no Redis, no sidecar.
- **libSQL / Turso via CoreLedger** (spec 003): durable relational data in
  a local SQLite file by default; the same driver speaks Turso
  embedded-replica sync for managed offsite durability; a Postgres driver
  (spec 011) slots in behind the same decorator surface when scale demands
  it.
- **rauthy, same container** (specs 005 and 007): the OIDC IdP ships
  inside the app image; rauthy is itself hiqlite-backed, keeping the
  entire stack in the SQLite family.

That was the founding thesis, and it stands. The grand refactor extends
it: severing the infrastructure coupling was never the end state, it was
the precondition for the **governed cell** (§4.1). An enrahitu app is a
self-contained unit that embeds its identity, its consensus, and its
durable state, exposes standard observability signals, and carries one
extracted model of what it contains and what it is permitted to do.
Encore cannot occupy this point in the design space because it
externalizes state and treats governance as out-of-band; the governed
cell makes one extracted model drive validation, capability enforcement,
and an append-only audit chain.

Result: one Docker image + one volume = a complete authenticated,
observable, governed application. Development and early deployment cost
nothing but a container host; scaling is "point CoreLedger at managed
Postgres" (spec 011) and, at the cell level, hiqlite Raft membership of
identical cells, not a rewrite.

## 2. Rewrite record

**2026-07-14.** First authored version, back-written from
`docs/ARCHITECTURE.md` after phases 0-5 shipped (`origin.retroactive`).

**2026-07-19, the grand refactor.** Ground-up rewrite from the
grand-refactor realignment record
(knowledge://grand-refactor/00-directional-vectors through
03-app-model-contract), mirroring the statecraft thesis rewrite
(statecraft spec 001), which is this substrate's first production
consumer. The realignment's six fork resolutions are decided input to
this spec, not open questions to re-litigate. What enters here: the
governed cell as the unit of the substrate, the React-only frontend
convergence, the flag-gated admin dashboard on the operator-role
convention, the per-app observability contract, and app-model.json as
the build/run-time contract with its phased enforcement seam. The
app-model contract itself lands as spec 020 in the same change;
implementation specs and the realignment of specs 002-019 follow (§5).

## 3. Territory

The repo shell: the Encore app manifest (`encore.app`), TypeScript
configuration (`tsconfig.json`), the vitest configuration and setup, and
the `backend/health/` service (liveness endpoint at `GET /health` plus
the phase-0 decorator canary). The root `package.json` links to this
spec via its manifest key. Subsystem directories are owned by specs
002-019; the app-model contract artifacts are owned by spec 020. This
spec owns the thesis and the sequencing; it deliberately owns no
subsystem behavior.

## 4. Behavior

### 4.1 The governed cell

The unit of the substrate is the cell: one container, one volume, and
inside it everything an application needs to be complete:

- **Embedded identity:** rauthy, reached only through the app's own
  origin (spec 005). Every cell is its own IdP for its own users.
- **Embedded consensus and coordination:** hiqlite in-process (spec 002)
  for cache, counters, locks, and notify; rauthy runs its own hiqlite as
  a container peer (separate state domains, one SQLite family).
- **Durable state behind one decorator surface:** CoreLedger (specs 003
  and 011). No Encore `SQLDatabase` anywhere.
- **A non-negotiable observability contract** (§4.5).
- **One extracted model, `app-model.json`** (spec 020), hash-anchored
  and drift-enforced, describing the cell's services, resources,
  capabilities, trust assignments, and gate configuration, with a
  Decision ledger whose genesis commits to the model hash (§4.6).

The cell composes with the two-plane model the statecraft thesis
records: statecraft-the-platform is ONE enrahitu app, and every stamped
tenant app is ANOTHER, independent one. The substrate side of that
model is a constraint on this repo: **the substrate never assumes a
platform above it.** A cell's IdP serves its own users, its `/metrics`
is scrapeable by whoever operates it, and its model is produced inside
its own build. Portability is by construction, not by export tooling:
a fleet-operated cell and a customer-self-hosted cell are the same
artifact, unchanged.

### 4.2 Repo-shaping decisions (retained)

1. **Single-package repo, app at the root.** No npm workspaces:
   workspaces made `encore build docker`'s `bundle_source` treat the
   workspace root as the bundle root in the template-encore PR #40 spike
   (the 3.7 GB failure mode). Frontend directories and `addon/` carry
   their own `package.json`s but are not workspace members. The root
   `tsconfig.json` and `vitest.config.ts` exclude every frontend
   directory (the SPAs typecheck and test under their own manifests) and
   `e2e/` (the Playwright suite, spec 017, runs under `test:e2e`).
2. **No Encore `SQLDatabase` anywhere.** `encore run` must not want
   Docker Postgres; the image build must not require database infra
   config. Durable state is CoreLedger's job (spec 003).
3. **Stage-3 TypeScript decorators only.** No `experimentalDecorators`,
   no `emitDecoratorMetadata`; metadata lives in module-level registries.
4. **No encore CLI.** Dev runs, typechecking, tests, and image builds all
   use the vendored toolchain (spec 008), driven directly via napi-rs.
   `tsconfig.json` excludes `vendor/` and `.encore/` from the walk;
   `vitest.config.ts` resolves the napi runtime from the vendored build.

### 4.3 Frontends: React-only convergence

The substrate converges on **two React frontends, and no Vue**:

- **`frontend`**: the app's user-facing SPA. Vite + React Router.
- **`frontend-admin`**: the first-class admin dashboard (§4.4).
  Vite + React Router, flag-gated.

This retires the frontend-as-a-flavor-slot posture in its current form:
today's tree carries `frontend/` (Vue, spec 006) and `frontend-react/`
(React + RR7, spec 015) as scaffold-selectable flavors. The target tree
carries the React pair above, period. Whether the `frontend` slot in
`template.toml` survives as a degenerate single-value knob or retires
outright is decided by the follow-up frontend spec together with the
009/014/015 realignment; any `template.toml` change rides that
realignment with its own contract bump. This spec constrains only the
destination: React-only, `frontend` + `frontend-admin`.

`~/DevWork/dashapp` (React 19 + react-router 7 + Vite 7 + TypeScript +
Tailwind, encore-styled) is a **functional reference for
`frontend-admin`, not a constraint**: study it, then reach for modern
patterns and better implementations where they exist; do not inherit its
construction wholesale.

### 4.4 The admin dashboard and the operator role

The encore.dev-style dashboard is rebuilt into the substrate as
`frontend-admin`: first-class, **flag-gated** (the end-user of a stamped
app chooses whether it is exposed at all), served same-origin like every
other surface, and rendering the cell's governed state (services,
capability rows, trust, ledger head, metrics) read-only from the model
and the runtime.

Access gates on the **`<app>_operator` role convention**: a custom
rauthy role named for the app (`statecraft_operator` for the platform;
each stamped app gets its own at stamp time). `rauthy_admin` is NOT the
dashboard role: it administers the IdP itself (users, clients,
providers) and stays with break-glass accounts. This costs nothing
(same out-of-the-box rauthy role mechanism, surfaced in token claims)
and removes the failure mode where every operator can silently edit the
identity plane. Operator-plane vs user-plane separation is a role plus
same-origin gating concern, never a second IdP.

### 4.5 Observability: the substrate contract

Every enrahitu app exposes the standard signals: a Prometheus
`/metrics` endpoint and OTel traces. **This is a non-negotiable
substrate capability**, recorded in the app model, present in every
cell whether or not anyone is scraping yet.

The contract deliberately stops at the signals. What consumes them is
the operator's choice per cell: the in-substrate admin dashboard
(§4.4), the customer's own Prometheus + Grafana, or a cloud tool. The
substrate never imposes a monitoring stack, and no cell's choice
constrains any other's.

Delivered by **spec 022** (2026-07-22): `backend/obs/` carries the
registry, the tracer, and the bounded in-process trace buffer; the
health service (this spec's territory) mounts the observation
middleware like every instrumented sibling, and the model records
`observability.otel: true` by extraction.

### 4.6 app-model.json and the phased seam

Every cell carries `app-model.json`: the language-neutral, extracted,
hash-anchored record of what the app contains and what it is permitted
to do. The contract (schema, determinism rules, versioning) is owned by
**spec 020**, which absorbs the grand-refactor v0.1 draft verbatim as
its starting point. This spec binds the substrate to the model's
position and its enforcement phasing:

- **The model is the sibling of `template.toml` (spec 009), never its
  replacement.** `template.toml` is the stamp-time contract between
  template and factory; the factory reads it and nothing else, and it
  is untouched by this rewrite. The model is the build/run-time
  contract of the app itself, produced inside the app's own build,
  after stamping. The fleet may record the model hash as placement
  metadata but never parses the model's interior.
- **Declare-verify-enforce, deny-by-default.** Capability declarations
  are the authoritative ceiling; the extractor verifies observed usage
  is a subset at build time; the kernel enforces at runtime; any
  operation outside a handler's effective capability set is denied and
  ledgered as a Decision. The committed model is a governed derived
  artifact in the spec-spine sense: stale or hand-edited fails the
  coupling gate.
- **The seam is the model, not the kernel.** Enforcement phases in
  behind the model, and every phase produces or consumes the same
  artifact:
  - **Phase A (near-term, this rewrite's implementation specs):**
    extraction from day one (the toolchain already drives tsparser;
    Phase A adds the lowering of encore meta + capability manifest to
    app-model.json, the verify step, and the hash anchor); the
    governance kernel at the existing napi boundary
    (`@statecrafting/kernel-native`, the generalization of chancery's
    kernel: gate + ledger + trust as a pure function) adjudicating the
    operations that already route through Rust; and the Decision ledger
    live, its genesis committing to the model hash. The whole TS tier
    gets attempt-deny-audit semantics with no new runtime machinery.
  - **Phase B (the deep axis):** the Rust handler tier with
    compile-time capability rows (single-shot effect dispatch as the
    only path from handler to kernel), actor mailboxes (plain tokio
    mpsc + oneshot) as the isolation and audit boundary, and cell
    clustering as hiqlite Raft membership. Phase B's extractor merges
    into the same model; swapping it in is invisible to every consumer.
- **Enforcement asymmetry, stated honestly.** The TS tier is
  disciplinary and auditable (attempt-deny-audit), not a sandbox: Node
  shares a process with the runtime, so its guarantees are static bans
  at build time, deny + ledger at the SDK/kernel boundary, and secret
  minimization (credentials live in the runtime config plane, never in
  the model). The Rust tier is cannot-express: a capability escalation
  is a reviewed diff, not a runtime event. Tier by privilege:
  TypeScript for breadth, Rust for the crown jewels.

### 4.7 Dependency posture

A governance-first substrate treats its own trust base as attack
surface. The rule is "own the pattern, vendor the load-bearing crate",
applied deliberately per dependency:

- **hiqlite: forked deliberately.** The family maintains its fork as
  the coordination-plane engine, tracking upstream. Two containment
  rules: the kernel never leaks hiqlite types (the storage-plane trait
  is the swap seam), and the fork never diverges on wire/disk format
  while rauthy-in-the-same-container runs registry hiqlite.
- **Effect dispatch: own the pattern, no dependency.** The Phase B
  effect crate is written in-house (corophage as design reference:
  single-shot handlers, no replay, which is exactly right for
  allow/deny governance).
- **Turso engine: keep-swappable, libSQL now.** Nothing authoritative
  lives in the read plane, so the engine is swappable by construction;
  revisit at Turso Database 1.0 with sync verified from primary
  sources.
- **rauthy: keep-upstream, pin.** Not embeddable as a library, so it is
  a container peer reached via OIDC; pin the image version, verify
  provenance.
- **Encore toolchain: already vendored** (spec 008), MPL-2.0 respected
  at file level. The app-model JSON contract is our own design; no
  proto file is copied.

### 4.8 Lineage

- **statecrafting/template-encore PR #40** proved a napi-rs addon
  linking hiqlite runs in-process under `encore run` AND inside an
  `encore build docker` image (two tokio runtimes, separate dylibs, no
  contention). Its caveats drive the hardening in specs 002 and 007.
- **template-encore `apps/api`** is the reference for the auth model,
  re-based here onto CoreLedger + hiqlite (spec 004).
- **chancery-kernel** (chancery's napi governance addon: action-gate +
  attest-ledger + trust-window over canonical-keysort-json, a pure
  function of its inputs) is the Phase A kernel in miniature;
  `@statecrafting/kernel-native` generalizes it from the message-send
  domain to arbitrary effects.

## 5. Sequencing

This session: this rewrite plus **spec 020** (the app-model contract,
absorbed). Follow-up specs, in dependency order:

1. **kernel-native**: `@statecrafting/kernel-native` at the napi
   boundary; the Decision ledger; Phase A enforcement semantics.
   Landed as **spec 021** (2026-07-20): extraction from day one, the
   kernel booted fail-closed from the committed model, the live
   Decision ledger, and the root manifest's kernel-native dependency
   plus the `extract:model` / `check:model` scripts ride with it.
2. **Frontend / dashboard / observability implementation specs**: the
   React-only convergence (§4.3), `frontend-admin` (§4.4), and the
   `/metrics` + OTel contract (§4.5) as buildable specs, realigning
   specs 006, 009 (slot list only, with its own contract bump), 014,
   and 015 as they land.
3. **Realignment of specs 002-019** where this thesis moved their
   ground (each realigned spec is amended in the change that moves its
   territory, per the coupling gate).

License boundary (load-bearing): this repo is Apache-2.0 and must stay
permissive because stamped apps copy template code (spec 009 §3.1).
Substrate packages consumed by stamped apps (`@statecrafting/toolchain`,
`hiqlite-native`, the planned `kernel-native`) are Apache-2.0. The AGPL
shield belongs to statecraft's control-plane addons downstream, on
which no permissive package may depend. `vendor/encore` is MPL-2.0 at
file level (spec 008).

## 6. Out of scope

- Subsystem behavior: owned by specs 002-019 and the follow-up specs of
  §5.
- The app-model schema, determinism rules, and versioning: spec 020.
- Phase B runtime internals (the effect crate, actor mailboxes, cell
  clustering): their own specs when their builds start, behind the
  model seam. Until then, multi-node operation remains out of scope.
- The statecraft control plane, fleet, and tenancy machinery
  (downstream repo; its thesis consumes this one).
- Kubernetes/Helm deployment artifacts: none exist here; deployment is
  fleet-owned by design (spec 009 §3.2).

## Amendment (2026-07-22): root excludes gain frontend-admin (spec 023)

`tsconfig.json` and `vitest.config.ts` (this spec's establishes) exclude
`frontend-admin/` like the two frontend flavors: the dashboard package
typechecks and builds under its own manifest (`npm run build:web-admin`),
never under the root compiler run.

## Amendment (2026-07-23): ledger durability constraints (spec 024)

An external architectural review argued the hiqlite/CoreLedger split
leaves the Decision ledger without the HA that hiqlite's unused Raft
could provide. The evaluation record: the concern is legitimate but
mis-aimed at today's topology (a single-node cell has no replication
to fork, and hiqlite is in-process per pod, so no cross-pod fencing
token exists to hold); the real present gaps were store-level chain
integrity and unmarked denial-append loss, both closed by spec 024.
Three constraints from that evaluation enter the thesis as law:

- **The outbox rule.** No invariant may span hiqlite and CoreLedger
  without an outbox and idempotent replay. Today no invariant spans
  them (hiqlite holds cache, counters, and coordination; CoreLedger
  holds durable truth), and that separation stays true by law, not
  luck: a future spec that couples the planes carries its outbox in
  its design or does not land.
- **Phase B doctrine: the chain head moves into hiqlite Raft.** When
  cells cluster (§4.6 Phase B: cell clustering as hiqlite Raft
  membership), the Decision chain's ordering authority (the chain
  head, possibly the commit log itself) moves into hiqlite Raft:
  commits durable in the consensus plane, indexes reproducible from
  them, Raft as the nameservice. This is the self-hosted analogue of
  Fluree's commits-durable/indexes-reproducible split. The addon
  facade (kv/counters today, spec 002) would need a chain-head API.
  The direction is recorded; nothing is built until hiqlite stops
  being per-process.
- **The portability boundary.** The CoreLedger decorator API stays
  portable across drivers for application tables: "point CoreLedger
  at managed Postgres" (§1) holds there, unchanged. The Decision
  chain and any future fact model live on the raw-driver layer
  beneath the decorators and may pin a driver family; portability of
  the enforcement plane's storage is a non-goal, deliberately. The
  decorator promise never silently extends to the proof plane.
