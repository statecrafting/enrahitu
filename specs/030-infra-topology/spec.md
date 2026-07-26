---
id: "030-infra-topology"
title: "Infra topology: the cell is the atom, not the ceiling"
status: approved
created: "2026-07-25"
implementation: pending
depends_on:
  - "001-enrahitu-architecture"
  - "002-in-process-hiqlite"
  - "005-rauthy-same-origin"
  - "007-single-container-packaging"
  - "009-template-contract"
  - "011-coreledger-postgres-driver"
  - "021-kernel-native-consumption"
  - "024-decision-chain-integrity"
establishes:
  - "docker/compose.cluster.yml"
  - { kind: directory, path: "backend/bus/" }
summary: >
  The zero-infrastructure single container was read, including by this
  corpus, as a prohibition on infrastructure. It was always a default.
  Encore's infra.config.json is the seam the runtime already provides for
  declaring real infrastructure, and the toolchain's runtime ships NSQ,
  Postgres, and Redis clients compiled in; this substrate has simply
  never populated the file beyond metadata and secrets. This spec makes
  the cluster topology a first-class, supported deployment shape: a
  compose file with Postgres and nsqd, N enrahitu containers sharing one
  ledger and one pub/sub bus, and encore.dev/pubsub Topic and
  Subscription usable exactly as they are in any Encore app. Doing that
  honestly requires naming what a second app container breaks, so this
  spec introduces a role selector (cell, app, idp), moves key material
  from per-volume generation to injection in multi-instance roles, and
  brings pub/sub under kernel adjudication so the bus does not become the
  one ungoverned channel out of a governed cell.
---

# 030: Infra topology

## 1. Purpose

An external review read the substrate as unable to scale past one box.
The reading is understandable and the fault is this corpus's: spec 001
says "zero managed-infrastructure dependencies", CLAUDE.md says
"`encore run` must never want Docker Postgres", and nothing anywhere
says what to do when one box is not enough. Absent a stated alternative,
a strong default reads as a limit.

It is not one. The cell (spec 001 section 4.1) is the unit of the
substrate: the smallest thing that is complete. A unit that is complete
alone is not thereby forbidden to compose. Two facts make composition
cheap, and both already exist:

1. **`infra.config.json` is the seam.** Encore's runtime takes its
   infrastructure from that file. This repo's copy declares `metadata`
   and `secrets` and stops, which is why the substrate looks
   infrastructure-free: it declared no infrastructure, not that it can
   have none. The runtime shipped in `@statecrafting/toolchain` carries
   `sql_servers`, `pubsub`, `redis`, `object_storage`, `hosted_services`,
   `hosted_gateways`, `graceful_shutdown`, and more, with NSQ compiled in
   (`runtimes/core/src/pubsub/nsq/`) alongside AWS and GCP clients.
2. **The kernel already anticipated it.** `actingService()` in
   `backend/kernel/adjudicate.ts` handles `meta.type === "pubsub-message"`
   attribution, and spec 024 moved the Decision chain's ordering
   authority into the store precisely so that two writers against one
   table produce a clean retry rather than a fork. The governance plane
   was built for more than one process.

What is missing is not capability. It is a stated topology, the compose
file that realizes it, and an honest account of what changes when a
second app container exists.

## 2. Territory

This spec owns:

- `docker/compose.cluster.yml`: the multi-container topology.
- `backend/bus/`: topic and subscription declarations, and the
  governed publish path in section 3.4.

It amends, without owning:

- `infra.config.json` (spec 007): the `pubsub` block and its
  environment-driven activation.
- `docker/entrypoint.sh` (spec 007): the role selector in section 3.2.
- `docker/first-boot.mjs` (spec 007): provisioning becomes
  role-dependent, section 3.3.
- `app-manifest.json` (spec 021): pub/sub capability kinds.
- `template.toml` and spec 009: an additive `[topologies]` table,
  contract v0.8.0.
- Spec 001 section 4.1: the thesis restatement in section 3.1, which is
  the amendment that makes this spec legible rather than contradictory.

## 3. Behavior

### 3.1 The thesis, restated

Spec 001 is amended to say what it always meant:

> The cell is the atom of the substrate: one container, one volume, and
> everything an application needs to be complete. Completeness is the
> invariant. Isolation is the default, not the invariant. A cell that
> requires no external infrastructure to be complete may still be
> composed with others, and with infrastructure, when a deployment needs
> it. What the substrate refuses is the Encore posture in which
> infrastructure is mandatory to develop and to run at all.

The default stamp is unchanged: one container, one volume, no external
dependency, `npm run dev` wanting nothing. That property is load bearing
and this spec does not spend it. Everything below activates only when
configured.

### 3.2 Roles

A second app container breaks three things that are safe in a single
cell, and pretending otherwise would be the failure mode of this spec.
The fix is to name what a container is for.

`ENRAHITU_ROLE` selects, defaulting to `cell`:

- **`cell`** (default): today's behavior exactly. rauthy on loopback,
  the app on 8080, everything on one volume, no external infrastructure.
- **`app`**: the application only. No rauthy process. `RAUTHY_UPSTREAM`
  points at the topology's idp service, so `backend/idp/proxy.ts` keeps
  serving `/auth/*` from this container's own origin and spec 005's
  same-origin invariant survives untouched: a browser still sees exactly
  one origin.
- **`idp`**: rauthy only. Owns the identity store and its volume.

The split exists because **rauthy's store has exactly one owner**.
rauthy embeds its own hiqlite; running the current image N times would
produce N independent identity stores, each with its own users, which is
not a cluster but a fault. The `idp` role makes the ownership explicit
instead of accidental.

`cell` remains the recommended shape for the overwhelming majority of
deployments. The cluster exists for the deployment that has outgrown it,
not as an aspiration.

### 3.3 What multiplies, and what must be shared

Stated plainly, because each of these is a real behavior change and
silence about any of them would be a defect:

**Key material must be injected, not generated.** `docker/first-boot.mjs`
generates JWT signing keys per volume. Two app containers generating
their own keys issue tokens the other rejects. In the `app` role,
first-boot does not generate: `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, the
refresh pair, `RAUTHY_CLIENT_SECRET`, and the metrics token (spec 025)
are required from the environment, and the container refuses to start
without them through the existing `ENRAHITU_REQUIRED_ENV` mechanism.
Generation stays exactly as it is in the `cell` role, so the simple case
keeps its zero-configuration property.

**hiqlite does not span containers.** It is in-process (spec 002), and
spec 024 already recorded that two pods hold two independent instances.
Therefore, in a multi-app topology:

- The cache is per-instance. Correct but colder, and a cache is allowed
  to be.
- **Rate limiting is per-instance**, so N containers admit N times the
  intended ceiling. This is a real weakening and the documentation says
  so rather than burying it. The limiter is not moved to a shared store
  in this spec: doing it properly means a shared counter authority, and
  the honest interim is a stated, quantified property plus the
  reverse-proxy layer where per-client limits belong in a fronted
  topology anyway.

**CoreLedger is shared and already safe.** Postgres via
`ENRAHITU_LEDGER_URL` (spec 011, shipped and CI-exercised). The Decision
chain's CAS append (spec 024) was designed for exactly this, so the
governance ledger is multi-writer correct today.

**Migrations become a deploy step**, per spec 027 section 3.4, rather
than something each booting container attempts.

### 3.4 Pub/sub, governed

`infra.config.json` gains a `pubsub` block naming an NSQ cluster,
populated from the environment so one image serves both topologies:
absent configuration, no bus is declared and nothing changes.

`backend/bus/` declares topics and subscriptions with
`encore.dev/pubsub` as any Encore app does. This is the first use of an
Encore infrastructure primitive in this substrate, and it is acceptable
where `SQLDatabase` is not, for a reason worth recording: `SQLDatabase`
would displace CoreLedger, which is the substrate's own durable-state
design and the thing specs 003, 011, 021, and 024 are built on. A topic
displaces nothing. There is no enrahitu message bus for it to compete
with.

**The bus is adjudicated.** A governed cell whose messages leave
unadjudicated has an ungoverned channel, and the whole kernel plane
would be arguable. Publishing therefore routes through a governed facade
in `backend/bus/`, in the same shape as `backend/kernel/hiq.ts` and
`backend/kernel/egress.ts`: `demand("pubsub.publish", "<topic>")` before
the message leaves the process. New capability kinds
(`cap.pubsub.<topic>.publish`, `cap.pubsub.<topic>.subscribe`) enter
`app-manifest.json`, so a service publishing to a topic it was not
granted is denied and the denial is ledgered like any other. Subscriber
attribution needs no new work: `actingService()` already resolves
`pubsub-message` requests.

**Postgres and `sql_servers`.** The compose topology runs a real
Postgres and the app really uses it, through CoreLedger's Postgres
driver on `ENRAHITU_LEDGER_URL`. The `sql_servers` block in
`infra.config.json` is deliberately **not** populated, because that block
exists to serve Encore's `SQLDatabase`, and adopting `SQLDatabase` would
mean two competing durable-state layers in one app. CLAUDE.md's rule
stands unamended and unweakened: no `SQLDatabase` anywhere, and
`npm run dev` still wants no Docker Postgres. The operator gets Postgres;
the app reaches it the way this substrate reaches durable state.

### 3.5 The compose topology

`docker/compose.cluster.yml` realizes the shape end to end:

```
postgres    shared CoreLedger store
nsqd        the bus (with nsqlookupd)
idp         enrahitu, ENRAHITU_ROLE=idp, its own volume
app-1       enrahitu, ENRAHITU_ROLE=app, no volume
app-2       enrahitu, ENRAHITU_ROLE=app, no volume
```

App containers are stateless: no volume, ledger on Postgres, keys
injected, cache and counters per-instance and disposable. Scaling is
`docker compose up --scale app=N`.

`docker/compose.dev.yml` (spec 005, the dev rauthy) is untouched. This
is a separate file for a separate purpose, and conflating them would
damage the dev loop for no gain.

### 3.6 Contract

`template.toml` gains an additive `[topologies]` table naming the
supported shapes and the compose file for each, so the factory and the
fleet can discover deployment options from the contract rather than from
folklore, which is the failure spec 009 exists to prevent. Contract
version to 0.8.0 (additive, minor).

## 4. Acceptance

1. The default stamp is byte-for-byte unaffected in behavior: a `cell`
   container starts with no compose, no Postgres, no nsqd, no injected
   keys, exactly as before. `npm run dev` requires no infrastructure.
2. `docker compose -f docker/compose.cluster.yml up --scale app=2`
   yields a topology where a login served by `app-1` produces a session
   that `app-2` accepts, proving shared keys and shared ledger.
3. A message published by `app-1` is received by a subscriber on
   `app-2`, proving the bus.
4. A publish to a topic the publishing service was not granted is
   denied with `KERNEL_DENIED` and appends a Decision, proving the bus
   is governed and not a hole in the model.
5. `app`-role containers refuse to start when key material is absent,
   naming every missing variable at once through the spec 007
   mechanism.
6. Two app containers writing denials concurrently produce a Decision
   chain that verifies, exercising spec 024's CAS append against real
   concurrency for the first time.
7. `app-model.json` regenerated by `npm run extract:model` contains the
   pub/sub capabilities and passes `npm run check:model`; the kernel
   boots on it.
8. `infra.config.json` contains no `sql_servers` block and the tree
   contains no `SQLDatabase` usage; a grep proving both is part of the
   test suite, so the rule cannot erode silently.
9. `template.toml` carries `[topologies]`, `[contract].version` is
   `0.8.0`, and spec 009 records the bump.
10. Spec 001 section 4.1 carries the section 3.1 restatement.
11. `npm run typecheck && npm test` green, coupling gate green.

## 5. Out of scope

- Highly-available rauthy. rauthy supports clustering; running more than
  one `idp` is a separate spec with its own quorum and volume
  questions. The `idp` role here is a single owner by design.
- A shared rate-limit authority across app containers. Named,
  quantified, and deferred in section 3.3.
- hiqlite Raft membership across cells. Spec 001 lists it as the cell-level
  scaling path and spec 024 recorded why it is not buildable while
  hiqlite is per-process; unchanged here.
- Encore `SQLDatabase`, object storage, Redis cache clusters, and Encore
  cron. Available in the runtime, deliberately unadopted; each would need
  its own justification against an existing substrate capability.
- Kubernetes manifests and Helm charts. The fleet's (statecraft spec
  006); this spec delivers the topology and the compose realization of
  it.
- Backup of the topology's Postgres and nsqd: spec 027 section 5.
- Message ordering, exactly-once delivery, and dead-letter policy beyond
  what NSQ and Encore's subscription configuration already provide.
