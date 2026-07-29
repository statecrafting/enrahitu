---
id: "030-infra-topology"
title: "Infra topology: N=1 is the primary mode, N=3 is the scale path"
status: approved
created: "2026-07-25"
implementation: pending
depends_on:
  - "001-enrahitu-architecture"
  - "002-in-process-hiqlite"
  - "005-rauthy-same-origin"
  - "007-single-container-packaging"
  - "009-template-contract"
  - "021-kernel-native-consumption"
  - "024-decision-chain-integrity"
establishes:
  - "docker/compose.cluster.yml"
  - { kind: directory, path: "backend/bus/" }
summary: >
  Rewritten 2026-07-27 for the pivot. The first version of this spec
  solved the wrong problem: it treated the single container as a limit to
  escape and designed a stateless app tier around a singleton identity
  provider, which required a role selector, a key-injection ceremony, and
  a shared external ledger. Once hiqlite is the state layer and rauthy
  clusters its own hiqlite alongside it, all three dissolve. The topology
  is now uniform: every replica is a stateful Raft member, one container
  by default with a single voter, and three or five members under a
  Kubernetes StatefulSet when a tenant outgrows it. N=1 is the primary
  mode and every behavior here is stated at N=1 first. This spec owns the
  cluster compose realization, the three operational requirements that
  make N>1 safe (PodDisruptionBudget, readiness-not-liveness on quorum,
  anti-affinity), the rule that Raft is never bridged across clusters,
  and the governed pub/sub path so the bus does not become the one
  ungoverned channel out of a governed deployment.
---

# 030: Infra topology

## 1. Purpose

An external review read the substrate as unable to scale past one box.
The reading was understandable and the fault was this corpus's, but the
first version of this spec answered it badly, and the correction is worth
recording because it is the same mistake in two forms.

That version accepted the premise that the single container was a
limitation and designed an escape from it: N stateless app containers in
front of a shared Postgres, with a singleton identity provider beside
them. That shape forced three pieces of machinery into existence. A role
selector (`cell`, `app`, `idp`), because rauthy's store has exactly one
owner. A key-injection ceremony, because stateless replicas cannot each
generate their own signing keys. And a shared external ledger, because
in-process state cannot be shared by processes.

All three were consequences of treating hiqlite as a cache and rauthy as
a singleton. The pivot (spec 001 §2) makes hiqlite the state layer and
clusters rauthy's own hiqlite the same way, and the machinery evaporates:
there is no stateless tier to inject keys into, no single-owner store to
protect with a role, and no external ledger to share, because the state
layer replicates. What is left is one topology at two sizes.

**N=1 is the primary mode**, not the degenerate case that a cluster spec
tolerates. Most tenants deploy one container and one volume forever
(spec 001 §4.1), and every section below states its behavior at N=1
first.

## 2. Territory

This spec owns:

- `docker/compose.cluster.yml`: the local multi-node topology, which
  exists so that three-node Raft is exercisable on a developer's machine
  and in CI rather than only in a cluster.
- `backend/bus/`: topic and subscription declarations, and the governed
  publish path in section 3.5.

It amends, without owning:

- `infra.config.json` (spec 007): the `pubsub` block and its
  environment-driven activation.
- `app-manifest.json` (spec 021): pub/sub capability kinds.
- `template.toml` and spec 009: an additive `[topologies]` table.

The default (N=1) compose topology is **not** owned here. It is the dev
substrate's (spec 001 §5.1 phase 1b), because the N=1 dev topology and
the N=1 deployment topology are the same thing, and splitting one file
across two specs is how they drift apart.

Kubernetes manifests are the fleet's (statecrafting spec 006, which this
spec's section 3.4 obliges to change shape). This spec specifies the
placement requirements; it does not carry the YAML.

## 3. Behavior

### 3.1 What multiplies

At N=1: one container, one volume, one command, a single Raft voter, no
quorum round-trip, and no configuration. Unchanged from today, and it
stays that way.

At N>1, every replica is the same thing: a stateful Raft member running
both rauthy and the app, each with its own storage. There is no role
selector and no asymmetry between replicas. This is the entire reason the
first version's machinery is gone.

**Two Raft clusters per deployment, four groups per replica.** rauthy
runs its own hiqlite (Sqlite + Cache groups); the app runs its own
(Sqlite + Cache groups). They are separate consensus domains that happen
to be co-located, which is why every readiness check below is an AND
across four groups rather than a single health bit.

**A shared volume between Raft nodes is data corruption, not a
simplification.** Each node owns its log, its state machine, and its
snapshots. This is stated as a prohibition because it is the
cost-saving instinct a reader will have when they see per-pod PVCs.

### 3.2 Key material

At N=1: `docker/first-boot.mjs` generates everything on first start, and
the zero-configuration property is preserved exactly.

At N>1: **one key set per deployment, injected into every replica, and
custodied once.** rauthy's `ENC_KEYS` decrypts its own store, so it must
be present in the environment before Raft starts and cannot be derived
from replicated state; the app's signing keys must match across replicas
or a session minted by one is rejected by another.

The custody requirement is not an operational footnote. Off-box backups
are encrypted with those keys, so **a tenant that loses them holds
unrecoverable ciphertext**, and a deployment with two independent key
custodies (rauthy's and the app's) doubles that exposure. One key set,
displayed once at provisioning for the operator to store, re-entry
verified before backups are reported healthy. The generation path stays
untouched at N=1 so the simple case pays none of this.

### 3.3 What does not span, and what to do about it

**hiqlite's cache group is not durable and is not replicated for
durability** (spec 001 §4.7). Two consequences at every N:

- The cache is warm per node. Correct but colder after a leader change,
  and a cache is allowed to be.
- **Rate limiting is per-node**, so N replicas admit N times the intended
  ceiling. This is a real weakening and it is stated rather than buried.
  It is not fixed here: doing it properly needs a shared counter
  authority with its own consistency argument, and in a fronted topology
  per-client limits belong at the reverse proxy anyway. Named, quantified,
  deferred.

**Notify is a hint; revision is truth.** SQL writes and notify land in
different Raft groups and cannot be atomic together (spec 001 §4.7), so
any consumer that treats delivery as a guarantee is incorrect. A resource
and its outbox row go in one SQL batch; the notify sits outside it; a
controller polls a revision watermark as the backstop.

**Migrations are a deploy step**, applied leader-only through Raft, not
something each booting replica attempts (spec 027).

### 3.4 The scale path

```
StatefulSet  control-plane  replicas: 3
  pod:
    container: rauthy   raft 8100 / api 8200  -> /data/rauthy (subPath)
    container: app      raft 8300 / api 8400  -> /data/app    (subPath)
    HQL_NODE_ID_FROM=k8s   both containers, one ordinal
  volumeClaimTemplate      per-pod PVC, NEVER shared
Service      headless      raft peer addressing
Deployment   readers       learner_only=true, no PVC, scale freely
```

Three operational requirements, each of which turns a routine event into
an outage if omitted:

1. **PodDisruptionBudget `maxUnavailable: 1`.** A node drain can
   otherwise evict two of three pods simultaneously and destroy quorum.
2. **Readiness reflects quorum; liveness must not.** Liveness on Raft
   health converts a transient quorum loss into a permanent restart loop,
   because the restart cannot restore the quorum it is waiting for.
   Readiness is an AND across all four Raft groups in the pod (rauthy
   sqlite + cache, app sqlite + cache). This is the same distinction spec
   025 §3.3 already drew for `/healthz` versus `/readyz`, applied to
   consensus.
3. **Anti-affinity across nodes and zones.**

Reader replicas run as learners: no PVC, no vote, scale freely. They are
the answer to the anonymous public surface at N>1 (spec 001 §4.9 ban 5),
which must not hit quorum per request.

**Raft is within-cluster, always** (spec 001 §4.1). Between clusters,
events go over pub/sub and identity goes over rauthy OIDC federation.
Bridging Raft across clusters is not a configuration this substrate
supports.

statecrafting spec 006 (fleet-native) currently encodes a Deployment plus
PVC placement shape. The object graph above is different (StatefulSet
with `volumeClaimTemplates`, headless Service, PodDisruptionBudget,
anti-affinity, separate learner Deployment), so that spec is reworked
rather than parameterized.

### 3.5 Pub/sub, governed

`infra.config.json` gains a `pubsub` block naming an NSQ cluster,
populated from the environment so one image serves every topology: absent
configuration, no bus is declared and nothing changes. The runtime ships
NSQ compiled in (`runtimes/core/src/pubsub/nsq/`).

`backend/bus/` declares topics and subscriptions with `encore.dev/pubsub`
as any Encore app does. This is the first use of an Encore infrastructure
primitive in this substrate, and it is acceptable where `SQLDatabase` is
not, for a reason worth recording: `SQLDatabase` would displace the state
layer this substrate owns. A topic displaces nothing, because there is no
enrahitu message bus for it to compete with.

**The bus is adjudicated.** A governed deployment whose messages leave
unadjudicated has an ungoverned channel, and the whole kernel plane would
be arguable. Publishing routes through a governed facade in
`backend/bus/`, in the same shape as `backend/kernel/hiq.ts` and
`backend/kernel/egress.ts`: `demand("pubsub.publish", "<topic>")` before
the message leaves the process. New capability kinds
(`cap.pubsub.<topic>.publish`, `cap.pubsub.<topic>.subscribe`) enter
`app-manifest.json`, so a service publishing to a topic it was not
granted is denied and the denial is ledgered like any other. Subscriber
attribution needs no new work: `actingService()` in
`backend/kernel/adjudicate.ts` already resolves `pubsub-message` requests.

The outbox drain (section 3.3) is a leased controller, which is why
`dlock` is on the phase 2 addon surface.

### 3.6 `sql_servers` stays unpopulated pending a decision

The first version of this spec ruled `sql_servers` out permanently, on
the grounds that it exists to serve `SQLDatabase`. That reasoning is
retained for the primitive and withdrawn for the slot: hiqlite replicates
its full database to every node, so unbounded data-plane history (audit
archive, discussion history, step logs, analytics) has to live somewhere
else, and the slot is one of three candidate answers.

Spec 001 §4.2 decision 2 holds the open question and the interface
contract (phase 1a) resolves it. Until then the block stays unpopulated
and no `SQLDatabase` is declared anywhere. The rule that stands
unweakened either way: **no `SQLDatabase`**, because adopting it would
put Encore in charge of durable state and its migrations.

### 3.7 Contract

`template.toml` gains an additive `[topologies]` table naming the
supported shapes and the compose file for each, so the factory and the
fleet discover deployment options from the contract rather than from
folklore, which is the failure spec 009 exists to prevent. The contract
version bump rides the phase 1c change that also resolves the frontend
slot, so the factory pins one new version rather than two.

## 4. Acceptance

1. N=1 is unaffected in behavior: one container starts with no compose,
   no external store, no injected keys, exactly as before, and the dev
   topology at N=1 is the deployment topology at N=1.
2. `docker compose -f docker/compose.cluster.yml up` yields a three-member
   deployment where a login served by any replica produces a session every
   other replica accepts, proving shared identity and replicated state.
3. Killing the Raft leader leaves the deployment serving reads and writes
   after election, and the killed member rejoins and catches up.
4. A message published by one replica is received by a subscriber on
   another, proving the bus.
5. A publish to a topic the publishing service was not granted is denied
   with `KERNEL_DENIED` and appends a Decision, proving the bus is
   governed and not a hole in the model.
6. Concurrent denial appends from two replicas produce a Decision chain
   that verifies, exercising spec 024's CAS append against real
   concurrency for the first time.
7. Readiness goes false and liveness stays true when quorum is lost;
   the deployment recovers without a restart loop.
8. `app-model.json` regenerated by `npm run extract:model` contains the
   pub/sub capabilities and passes `npm run check:model`; the kernel
   boots on it.
9. `infra.config.json` contains no `sql_servers` block and the tree
   contains no `SQLDatabase` usage; a grep proving both is part of the
   test suite, so the rule cannot erode silently.
10. `template.toml` carries `[topologies]` and spec 009 records the bump.
11. `npm run typecheck && npm test` green, coupling gate green.

## 5. Out of scope

- The default (N=1) compose topology and the dev loop: phase 1b's, per
  section 2.
- The addon surface that N>1 depends on (cluster config passthrough,
  `dlock`, replicated SQL): phase 2, gated on the interface contract.
  This spec is `implementation: pending` for that reason.
- A shared rate-limit authority across replicas. Named, quantified, and
  deferred in section 3.3.
- Kubernetes manifests and Helm charts: the fleet's (statecrafting spec
  006). This spec states the placement requirements they must satisfy.
- Backup and restore of a multi-member deployment: spec 027. Restore at
  N>=3 is a cluster reset rather than a data restore, and it has its own
  runbook.
- Encore `SQLDatabase`, object storage, Redis, and Encore cron.
  Available in the runtime, deliberately unadopted; each would need its
  own justification against an existing substrate capability.
- Message ordering, exactly-once delivery, and dead-letter policy beyond
  what NSQ and Encore's subscription configuration already provide.

## 6. Rewrite record

**2026-07-25.** First authored, against the pre-pivot thesis: stateless
app tier, singleton `idp`, shared Postgres ledger, role selector.

**2026-07-27, the pivot.** Rewritten rather than amended, because the
premise changed rather than the details. What was deleted and why:

- **The `ENRAHITU_ROLE` selector (`cell` / `app` / `idp`).** It existed
  because rauthy's store had exactly one owner. Clustering rauthy's own
  hiqlite removes the singleton, so the roles have nothing left to
  distinguish.
- **The injected-key ceremony for a stateless app tier.** There is no
  stateless tier. Key injection survives at N>1 for a different and
  better-stated reason (section 3.2: one custody, because backups are
  encrypted with it).
- **Shared external CoreLedger as the multi-writer story.** The state
  layer replicates, so the shared store is no longer what makes N>1
  work. Postgres remains a candidate for unbounded overflow only
  (section 3.6).

What survived unchanged: the governed bus (section 3.5), the refusal to
adopt `SQLDatabase`, and the observation that `actingService()` already
resolves `pubsub-message` attribution. What is new: the scale path
(section 3.4) and its three operational requirements.
