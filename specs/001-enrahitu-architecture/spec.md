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
  - "scripts/check-licenses.mjs"
  - "scripts/check-licenses.test.ts"
summary: >
  The architecture thesis and the app shell. enrahitu is a membership and
  association management platform for non-profits and associations,
  shipped as a working application that organizations extend rather than
  fork. Encore.ts is kept as the edge, contract, and external-seam layer
  and stops being the process supervisor; hiqlite stops being a cache and
  becomes the replicated state layer; rauthy stops being a login page and
  becomes the principal authority, reached only through the app's own
  origin. Every deployment carries one extracted, hash-anchored model
  (app-model.json, spec 020) of what it contains and what it is permitted
  to do, enforced by a kernel and recorded in a hash-chained Decision
  ledger, plus a non-negotiable observability contract (Prometheus
  /metrics + OTel). The deployment unit is one container and one volume by
  default: N=1 is the primary mode, not a degenerate case, and becomes a
  three or five node Raft cluster when a tenant outgrows it. Development
  is docker-only. The frontend converges React-only: frontend (the
  member-facing SPA) plus frontend-admin (the flag-gated operator
  dashboard, gated on the <app>_operator role convention). This spec owns
  the repo-shell units (Encore app manifest, TypeScript and test
  configuration, the health service), anchors the root package, and
  carries the corpus disposition table (section 5) recording how every
  other spec stands after the 2026-07-27 pivot. The build toolchain is
  consumed as published packages and driven directly via napi-rs with no
  encore CLI (spec 008), and the repo doubles as the template chassis the
  Statecraft factory stamps (spec 009). The name enrahitu is kept as a
  proper noun; its former expansion no longer describes the stack.
---

# 001: enrahitu architecture

## 1. Purpose

Encore.ts is an excellent application framework, but its business model
monetizes cloud provisioning, so its primitives (notably `SQLDatabase`)
couple application code to managed infrastructure. enrahitu keeps the
framework for what it is good at and owns the rest:

- **Encore.ts** holds the edge: API surface, contracts, generated
  clients, and the external seams declared in `infra.config.json`. It
  does not hold state, and it is not the process supervisor.
- **hiqlite** holds state and coordination (spec 002): replicated SQL,
  notify, distributed locks, and counters, in-process via a napi-rs
  addon. Raft runs with a single voter at N=1 and with three or five
  when a tenant needs it.
- **rauthy** holds identity (spec 005): authentication and principal
  identity, reached only through the app's own origin. It is consumed at
  its API surface and never forked.
- **Application code** holds intent and reconciliation: typed,
  tenant-scoped resources admitted through a kernel, and controllers
  that drive intent into status.

The founding thesis (sever the managed-infrastructure coupling) stands
and was never the end state. It was the precondition for shipping a
product whose surface *is* replicated state, identity, and adjudicated
decisions. Encore cannot occupy this point in the design space because it
externalizes state and treats governance as out-of-band; here, one
extracted model drives validation, capability enforcement, and an
append-only audit chain, and that chain is a feature the buyer pays for
rather than an implementation detail.

Result: one container and one volume is a complete authenticated,
observable, governed application, deployable by an organization with no
ops team. Scaling is a Raft membership change, not a rewrite.

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

**2026-07-25, the exposure review.** An external evaluation of the
packaged image found four defects that exist only once the cell is
reachable by a stranger, plus a set of product gaps around operating one
over time. All were verified against the code and none contradicted the
thesis; they are the substrate failing to use protections it had already
built, plus missing operational vocabulary. The resulting specs are
025 (substrate hardening), 026 (IdP mail delivery), 027 (operational
verbs), 028 (operator documentation), 029 (supply-chain provenance),
030 (infra topology), and 031 (admin evidence export). The one thesis-level
clarification is recorded in section 4.1: completeness, not isolation, is
the invariant.

**2026-07-27, the pivot.** The substrate acquired a product and a buyer:
a membership and association management platform for non-profits and
associations, shipped as a working application rather than a template to
be filled in. Section 4.1 is rewritten accordingly, and so is section 4.2
decision 4.

The correction that matters most, because it will otherwise be
re-proposed: **the zero-docker development invariant was wrong and is
deleted.** "Development requires no infrastructure" was a convenience
that this corpus had promoted to a principle, and it is incompatible with
a cluster-capable target: three-node Raft cannot be developed or tested
without a container topology, so the invariant would have forced every
clustering concern to be verified somewhere other than where developers
work. It also produced a standing dev/production divergence (two
orchestration paths, two infra configs, two auth wirings) whose defects
were visible only in CI, which is how the spec 017 login e2e came to need
three separate environment-shaped fixes that no local run could reveal.
Development is now docker-only.

**What is unaffected:** the deployment completeness invariant. A
deployment still requires no external infrastructure to be complete, and
that property is the product. The 2026-07-25 clarification (completeness,
not isolation) survives intact; the pivot separates the deployment claim
from the development claim, which had been conflated, and keeps the one
that was true.

Turso is benched (section 4.7), so the former acronym expansion no longer
describes the stack; the name is kept as a proper noun. The corpus-wide
consequences are recorded as a disposition table in section 5 rather than
discovered spec by spec.

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

### 4.1 The product, the unit, and the two invariants

**What this is.** A membership and association management platform:
members, tiers, renewals, dues, events, registrations, volunteers,
documents, board governance, announcements, and threaded discussion.
Self-hosted, with the organization's own identity provider. It ships as
a working application that an organization extends rather than forks
(§9 of the pivot record; the extension seam is its own spec, §5). The
incumbents (Wild Apricot, MemberClicks, Neon CRM, Glue Up) are
expensive, SaaS-only, and generally disliked; cost and data sovereignty
are the buying reasons.

Naming the buyer is load bearing, not marketing. A 200-member
association has no ops team, and the organizations that could run a
StatefulSet with PodDisruptionBudgets and zone anti-affinity are not the
ones buying association management. Every sizing and defaults question
in this corpus resolves against that reader.

**Why this substrate fits.** Every property that was awkward in a
general-purpose framework is an asset here. Per-deployment rauthy means
members authenticate to their own organization rather than to a vendor
tenant. The hash-chained Decision ledger is what board votes, approvals,
and grant compliance actually need. Self-hosting answers data
sovereignty. Writes are human-paced. Users are enrolled, not anonymous.
The operator plane and the member plane are genuinely distinct.

**Layer ownership, with no overlap.** Edge, contract, and external seams
belong to Encore.ts; identity to rauthy; state and coordination to
hiqlite; intent and reconciliation to application code. Encore.ts is not
the process supervisor. hiqlite is not a cache. rauthy is not a login
page.

**N=1 is the primary mode.** One container, one volume, one command.
Raft runs with a single voter, so there is no quorum round-trip and the
anonymous public surface is a caching question rather than an
architectural one. This is what the documentation leads with, what the
demo runs, and what most tenants deploy forever. Every spec in this
corpus states its behavior at N=1 first and treats N=3 as the additional
case; the reverse ordering is how a cluster assumption leaks into code
paths that a single container then works around. **If N=1 ever stops
being a single-command deploy, the product has lost its buyer, not
merely some convenience.**

**Deployment completeness survives; zero-infrastructure development does
not.** These were carried as one claim. They are two, and only one of
them was ever true.

- *A deployment requires no external infrastructure to be complete.*
  True, retained, and it is the product. One container and one volume is
  a whole authenticated, observable, governed application.
- *Development requires no infrastructure.* False, deleted, and not to
  be reintroduced. Development is docker-only: the app, its identity
  provider, and its state layer come up together under compose, and the
  N=1 dev topology is the N=1 deployment topology. The rewrite record
  (§2, 2026-07-27) states why.

Do not delete both, and do not restore the second. The completeness
invariant is what is being sold; the development invariant was a
convenience mistaken for a principle.

A deployment that is complete alone is not thereby forbidden to compose.
`infra.config.json` is the seam the runtime provides for declaring real
infrastructure, and composing with it (a shared archive store, a pub/sub
bus, N app replicas) is a supported shape governed by spec 030. What
this substrate refuses is the Encore posture in which infrastructure is
mandatory to run at all, not infrastructure itself.

**Raft is within-cluster, always.** It is never bridged across clusters.
Between clusters, events go over Encore pub/sub and identity goes over
rauthy OIDC federation. A shared volume between Raft nodes is data
corruption, not a simplification: each node owns its log, state machine,
and snapshots.

**The substrate never assumes a platform above it.** A deployment's IdP
serves its own users, its `/metrics` is scrapeable by whoever operates
it, and its model is produced inside its own build. Portability is by
construction, not by export tooling: a fleet-operated tenant and a
customer-self-hosted tenant are the same artifact, unchanged. This
composes with the two-plane model the statecraft thesis records:
statecraft-the-platform is ONE enrahitu app, and every stamped tenant app
is ANOTHER, independent one.

### 4.2 Repo-shaping decisions

Decisions 1 and 3 are retained unchanged from the 2026-07-19 rewrite.
Decisions 2 and 4 are rewritten by the 2026-07-27 pivot.

1. **Single-package repo, app at the root.** No npm workspaces:
   workspaces made `encore build docker`'s `bundle_source` treat the
   workspace root as the bundle root in the template-encore PR #40 spike
   (the 3.7 GB failure mode). Frontend directories carry their own
   `package.json`s but are not workspace members. The root
   `tsconfig.json` and `vitest.config.ts` exclude every frontend
   directory (the SPAs typecheck and test under their own manifests) and
   `e2e/` (the Playwright suite, spec 017, runs under `test:e2e`).
2. **No Encore `SQLDatabase` anywhere; the `sql_servers` slot is a
   separate question.** These were one rule and must not stay one. The
   ban is on the *primitive*: adopting `SQLDatabase` would put Encore in
   charge of durable state and its migrations, displacing the state layer
   this substrate owns. That ban is unchanged and unweakened.

   The `sql_servers` *slot* in `infra.config.json` is not the same thing.
   hiqlite replicates its full database to every node, so nothing
   unbounded may live in it (§4.7), and unbounded data-plane history
   (audit archive, discussion history, step logs, analytics) needs
   somewhere else to go. Whether that overflow is reached through a
   populated `sql_servers` block, through a direct driver connection as
   the CoreLedger Postgres driver does today (spec 011), or through
   object storage as sealed archive segments, is **an open decision
   resolved by the interface contract** (§5, phase 1a), not a default.
   Until it is resolved, the slot stays unpopulated and no `SQLDatabase`
   is declared. Recorded as open rather than silently settled, because
   answering it by writing code would be exactly the drift the coherence
   guard exists to prevent.
3. **Stage-3 TypeScript decorators only.** No `experimentalDecorators`,
   no `emitDecoratorMetadata`; metadata lives in module-level registries.
4. **No encore CLI, and development runs in docker.** The build
   toolchain (parse, compile, bundle, extract) is the published
   `@statecrafting/toolchain` driven directly via napi-rs (spec 008);
   the `encore` binary is not used anywhere and is not a prerequisite.
   What the pivot changes is where the app runs: dev is a compose
   topology whose N=1 tier is the N=1 deployment topology, not a
   plain-node process on the host. The CLI is still absent; what replaced
   it is a container topology plus the operator dashboard (§4.4), which
   already carries the service catalog, the API caller, and the trace
   waterfall the CLI's dev dashboard provided. `tsconfig.json` excludes
   `.encore/` from the walk; `vitest.config.ts` resolves the napi runtime
   from the installed toolchain platform package.

### 4.3 Frontends: React-only convergence

The substrate converges on **two React frontends, and no Vue**:

- **`frontend`**: the app's user-facing SPA. Vite + React Router.
- **`frontend-admin`**: the first-class admin dashboard (§4.4).
  Vite + React Router, flag-gated.

This retires the frontend-as-a-flavor-slot posture in its current form:
today's tree carries `frontend/` (Vue, spec 006) and `frontend-react/`
(React + RR7, spec 015) as scaffold-selectable flavors. The target tree
carries the React pair above, period.

**2026-07-27: this is now scheduled, not deferred.** The 2026-07-19
rewrite left execution to "the follow-up frontend spec", which was never
authored, so the divergence stood for eight days across three
disagreeing surfaces (this spec, the tree, and `template.toml`'s
`frontend = { default = "vue" }`). It lands in phase 1c (§5): Vue
retires, `frontend-react/` becomes `frontend/`, and the `frontend` slot
resolves with its own contract bump. The `hiq` HTTP demo surface retires
in the same change, because the SPA is its only consumer and carrying it
through the pivot would mean keeping six endpoints working against a
state layer being rewritten underneath.

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

- **hiqlite: forked deliberately, and now the state layer.** The family
  maintains its fork as the state and coordination engine, tracking
  upstream. Containment rules: the kernel never leaks hiqlite types (the
  storage-plane trait is the swap seam), and the fork never diverges on
  wire/disk format while rauthy in the same deployment runs registry
  hiqlite.

  Two properties of the engine are constraints on every downstream spec,
  so they are recorded here rather than rediscovered:

  - **It replicates the full database to every node.** Nothing unbounded
    may live in it. Audit history, discussion history, step logs, and
    analytics need retention or offload (§4.2 decision 2).
  - **It runs two Raft groups** (`RaftType::Sqlite` and `RaftType::Cache`,
    `hiqlite/src/app_state.rs`). SQL writes and notify land in different
    consensus groups and therefore **cannot be atomic together**: a
    resource plus its outbox row in one SQL batch is atomic, the notify
    is not. Notify is a latency hint; a revision watermark is truth, and
    a consumer that treats delivery as a guarantee is incorrect.
  - **The cache group is not durable and is not backed up.** Backups
    cover the SQLite group only (`BACKUP_DB_NAME = "restore.sqlite"`;
    every path in `backup.rs` derives from the sqlite state machine).
    Counters, lock state, and cache KV do not survive a restore, so
    nothing durable goes in cache.
- **Effect dispatch: own the pattern, no dependency.** The Phase B
  effect crate is written in-house (corophage as design reference:
  single-shot handlers, no replay, which is exactly right for
  allow/deny governance).
- **Turso and libSQL: benched.** libSQL was the durable store and the
  "Tu" in the former acronym. hiqlite's replicated SQL takes that role,
  so libSQL becomes an optional alternative primary rather than the
  default. This is a driver swap, not a migration: `LedgerDriver` /
  `LedgerTx` / `SqlStatement` / `ExecuteResult` in
  `backend/core/ledger/driver.ts` are a real interface, libSQL is 13
  references across `backend/`, and a `HiqliteDriver` slots in beside
  `LibsqlDriver` and `PostgresDriver`. Revisit Turso at Database 1.0 with
  sync verified from primary sources.
- **rauthy: keep-upstream, pin, and do not fork.** It has no embedding
  seam (its actix `HttpServer` is constructed in `src/bin/src/server.rs`),
  and forking incurs a permanent rebase tax against a 75k-line upstream
  under active development. It is consumed at its API surface with zero
  source changes, as a process peer reached via OIDC. Pin the image
  version, verify provenance.
- **Encore toolchain: published, consumed via napi-rs** (spec 008),
  MPL-2.0 respected at file level. The app-model JSON contract is our own
  design; no proto file is copied.
- **The AGPL boundary is a hard edge.** Customer-reaching packages never
  depend on AGPL-licensed ones. Admission and audit route through
  `@statecrafting/kernel-native` (Apache-2.0), never
  `@statecrafting/governance-native` (AGPL-3.0). The names differ by one
  word and the mistake is easy, so it is machine-checked here rather than
  remembered: `scripts/check-licenses.mjs` fails the build, and it runs
  in this repo because this repo's `package.json` is where such a
  dependency would be declared. This repo is Apache-2.0 and must stay
  permissive because stamped apps copy template code (spec 009 §3.1).

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

### 4.9 Product scope bans

Five bans, recorded at thesis level because each is a direction a
reasonable contributor would otherwise take and each would consume the
roadmap. They constrain specs 026 through 031 and everything after.

1. **Do not build Slack.** Threads, reactions, search, files, mobile
   push, and integrations is a multi-year product with mature free
   competitors (Mattermost, Rocket.Chat, Zulip, Element) whose nonprofit
   discounts gut the affordability argument. Communication is a feature
   of the membership platform, not its center: ship announcements plus
   threaded, Discourse-shaped discussion. Real-time chat is a later
   module and must not be allowed to swallow the roadmap. Volunteer
   organizations usually need async discussion more than real-time chat.
2. **Do not touch card data.** Self-hosted plus PCI scope is a bad
   combination. Integrate hosted checkout, or track dues as invoices
   marked paid, which is what many associations already do.
3. **Do not become an MTA.** Self-hosted deliverability is brutal.
   A bring-your-own SMTP relay is a hard requirement, which makes spec
   026 larger than IdP mail: it becomes the platform's outbound channel
   (renewal notices, event confirmations, announcements).
4. **Do not build a CMS.** The public surface is bounded: a handful of
   editable pages, a public events list, and a join form. Not a page
   builder.
5. **The public surface is a new access path.** Everything designed
   before the pivot assumed authenticated, enrolled users. Anonymous
   read traffic is served from cache or pre-rendered output. At N=1 this
   is a caching question; at N>1 it must not hit quorum per request.

## 5. Sequencing and corpus disposition

### 5.1 Phases

Ordered by dependency, not by appetite. Phase 1's three tracks are
independent and run in parallel.

- **Phase 0, corpus realignment (this change).** Specs only, no runtime
  behavior. This rewrite, spec 002's false invariants deleted, spec 030
  rewritten, the license guard added, and the disposition table below so
  that no stale spec reads as current truth.
- **Phase 1a, the interface contract. Landed as spec 032** (2026-07-29).
  The addon's surface written down before the addon is built: atomicity
  boundary, notify envelope, read consistency, lease semantics,
  watermark, migration ownership, chain head placement, backup surface,
  archive mechanics, and local-only notify, plus the auth boundary
  (§5.3). Its own document, because it is read repeatedly during addon
  work while this spec is read once to orient. Checking each decision
  against hiqlite's implementation rather than its documentation changed
  three answers: the lock TTL is hardcoded at ten seconds, the lock id is
  already a fencing token, and the notify bus is one global channel whose
  events may replay. Four of the ten decisions add nothing to the addon
  surface, which is the contract doing its job.
- **Phase 1b, the dev substrate.** Docker-only tiered compose with N=1 as
  the default tier, generated `infra.config.<topology>.json` from one
  source, backend watch, the app-level test harness, and the single-shot
  restore marker in `docker/first-boot.mjs`. Closes spec 025 §5 items 1,
  4, and 6, which is what moves spec 025 to `implementation: complete`.
- **Phase 1c, frontend convergence.** §4.3 executed.
- **Phase 2, the addon expansion (the gate).** `sqlite`, `dlock`, and
  `listen_notify_local` features, cluster config passthrough, and the
  TS surface (`query` / `execute` / `txn` / `listen` / `notify` / `lock`
  / backup). Nothing above it is testable until it exists. It lives in
  `statecrafting/statecrafting`, and is developed against this repo by
  patching `node_modules` rather than waiting on a publish.
- **Phase 3, control plane architecture.** Kinds, admission, watch,
  controllers, audit. Back-written from what real nodes did, not
  designed ahead of them.
- **Phase 4, the chassis/tree boundary and upgrade mechanics.** Decides
  what the application baseline is allowed to contain, so it lands
  before the baseline and after the control plane.
- **Phase 5, the application baseline.** The association domain, written
  against the real store. It ships and it stays; there is no prunable
  example slot.

Durability is designed in at phases 1a and 1b, not retrofitted: the
backup surface is part of the addon contract and the restore marker is
part of the dev substrate's entrypoint work.

### 5.2 Disposition of every spec

Recorded here so a contributor opening any spec knows whether it is
current. "Rewrite pending" means the spec still accurately describes what
is built and must not be rewritten ahead of the code; the pivot has
moved its ground and the rewrite rides the change that moves its
territory, per the coupling gate.

| Spec | Disposition |
|---|---|
| 002 in-process hiqlite | **Rewritten, phase 0**: the single-node and clustering-out-of-scope invariants deleted. Rewritten again in phase 2 when the addon surface exists. |
| 003 CoreLedger | **Rewrite pending, phase 2**: libSQL stops being the primary store; a `HiqliteDriver` joins the driver seam. |
| 004 auth-core | **Rewrite pending, phase 2**: rauthy becomes the principal authority (§5.3). |
| 005 rauthy same-origin | **Survives.** The proxy design is verified e2e (spec 017) and unchanged; only its upstream target moves with the topology. |
| 006 webapp SPA | **Partial retirement, phase 1c**: the Vue source retires; `backend/web/` (the static service) survives here. |
| 007 packaging | **Survives, amended in phase 1b**: first-boot gains the single-shot restore marker; the entrypoint aligns with the N=1 topology. |
| 008 toolchain | **Survives.** |
| 009 template contract | **Amended, phase 1c**: frontend slot resolution and contract bump. The application is not a slot: it ships and stays. |
| 010 template-encore absorption | **Survives** (historical record). |
| 011 CoreLedger Postgres driver | **Disposition changes, phase 2**: Postgres stops being the durable-state scale path and becomes a candidate for unbounded overflow, pending §4.2 decision 2. |
| 012 born-with provenance | **Survives.** |
| 013 Pages deploy slot | **Amended, phase 1c**: targets the surviving frontend. |
| 014 scaffold verb | **Amended, phase 1c**: flavor pruning changes; no example slot. |
| 015 react-rr7 flavor | **Absorbed, phase 1c**: `frontend-react/` becomes `frontend/` and this spec becomes the frontend spec. |
| 016 amd64 image | **Survives.** |
| 017 IdP login e2e | **Survives, moves in phase 1b** onto the compose topology. |
| 018 packaged chassis | **Survives.** |
| 019 two-directory layout | **Survives.** |
| 020 app-model contract | **Survives, extends in phase 3**: the model becomes the kind registry. |
| 021 kernel-native consumption | **Survives, extends in phase 3**: adjudication becomes admission. |
| 022 observability contract | **Survives.** |
| 023 frontend-admin | **Survives**, and is the single most expensive asset in the tree: the rebuilt Encore dev dashboard (catalog, API caller, traces, waterfall). Do not rebuild it. |
| 024 decision chain integrity | **Rewrite pending, phase 1a**: its outbox rule and portability boundary were written against a hiqlite/CoreLedger split the pivot dissolves. The CAS append survives and becomes the audit spine of admission. |
| 025 substrate hardening | **In progress; completed by phase 1b.** |
| 026 IdP mail delivery | **Pulled forward, scope grows**: the platform's outbound channel, on a bring-your-own SMTP relay (§4.9 ban 3). |
| 027 operational verbs | **Grows**: gains the restore verb and its runbook. Restore at N>=3 is a cluster reset, not a data restore, and the tenant assurance must not imply otherwise. |
| 028 operator documentation | **Survives, grows.** |
| 029 supply-chain provenance | **Survives.** |
| 030 infra topology | **Rewritten, phase 0.** |
| 031 admin evidence export | **Pulled forward**: grant reporting is a buying reason, and open-format portability is a separate feature from backup. Conflating them fails a procurement review. |

New specs, in phase order: the interface contract (1a), the dev
substrate (1b), frontend convergence (1c), control plane architecture
(3), the chassis/tree boundary and upgrade mechanics (4), and the
application baseline (5). Durability lands across 1a, 1b, and 027.

Cross-repo: statecrafting spec 003 (hiqlite-native) is amended for the
addon expansion, and statecrafting spec 006 (fleet-native) is reworked,
because its placement shape encodes Deployment plus PVC where the scale
path needs a StatefulSet with `volumeClaimTemplates`, a headless Service,
a PodDisruptionBudget, anti-affinity, and a separate learner Deployment.
That is a different object graph, and spec 006 has recent activity on
`main`, so the rework is scheduled rather than assumed.

### 5.3 The auth boundary (decided 2026-07-29)

rauthy owns authentication and principal identity. This model owns
authorization bindings: `Tenant`, principal bindings, and role-to-policy
bindings are product data joined on rauthy's `sub`. Tenancy does not live
in rauthy groups, because that would make rauthy's admin UI the tenant
admin UI.

The resolution for spec 004, which the pivot left undefined: **a thin
adapter.** `UserAccount` and `RefreshToken` retire along with the app's
own refresh rotation; the app stops minting its own refresh tokens and
derives its session from rauthy's, keeping the same-origin httpOnly
cookie shell and the CSRF double-submit. Rotation and revocation
semantics become rauthy's to define, which is the cost being accepted in
exchange for having exactly one session authority. `AuditLog` does not
retire with them: it is application data that outlives the auth rewrite.

This is decided at thesis level rather than in phase 2 because phase 1b's
test harness needs a settled authentication story to authenticate
against, and a harness written for the wrong one would be rewritten.

## 6. Out of scope

- Subsystem behavior: owned by specs 002-019 and the follow-up specs of
  §5.
- The app-model schema, determinism rules, and versioning: spec 020.
- Phase B runtime internals (the effect crate, actor mailboxes): their
  own specs when their builds start, behind the model seam. Multi-node
  operation is **no longer out of scope**: it is the scale path of §4.1,
  specified by spec 030 and gated on the addon expansion (§5.1 phase 2).
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

**Pivot note (2026-07-27).** All three constraints survive, and two of
them change meaning, which is why spec 024 is marked rewrite-pending
(§5.2) rather than left alone:

- **The outbox rule survives and gets sharper.** It was written for an
  invariant spanning hiqlite and CoreLedger, a split the pivot dissolves.
  It re-lands one level down, inside hiqlite: SQL writes and notify are
  in *different Raft groups* (§4.7) and cannot be atomic together, so a
  resource plus its outbox row goes in one SQL batch and the notify sits
  outside it. The rule stops being about two stores and becomes about two
  consensus groups.
- **The chain-head doctrine moves from Phase B to phase 1a.** It was
  deferred on the grounds that hiqlite was per-process and had no
  chain-head API. Both premises expire with the addon expansion, so
  placement becomes an interface-contract decision rather than a
  direction: the head and a hot window live where linearizable
  read-modify-write happens, and sealed segments archive out, each
  linking to its predecessor's hash so archived history stays verifiable
  without being resident. Unbounded audit history cannot stay in a fully
  replicated store (§4.7).
- **The portability boundary is unchanged.**
