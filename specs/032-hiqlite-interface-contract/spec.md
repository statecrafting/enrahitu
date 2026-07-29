---
id: "032-hiqlite-interface-contract"
title: "The hiqlite interface contract: ten decisions before the addon"
status: approved
created: "2026-07-29"
implementation: pending
depends_on:
  - "001-enrahitu-architecture"
  - "002-in-process-hiqlite"
  - "021-kernel-native-consumption"
  - "024-decision-chain-integrity"
establishes:
  - { kind: directory, path: "backend/state/" }
summary: >
  Phase 1a of the pivot (spec 001 §5.1). The expanded hiqlite addon is the
  gate: nothing above it is testable until it exists, and its surface is
  either derived from stated requirements or guessed. This spec states the
  requirements. Ten decisions, each with the question, the resolution, the
  reason, and what it determines about the addon surface: atomicity
  boundary, notify envelope, read consistency, lease semantics, watermark,
  migration ownership, CAS and audit placement, backup surface, archive
  mechanics, and local-only notify. Every decision is checked against
  hiqlite's actual implementation rather than its documentation, which
  surfaced three constraints that change the answers: the distributed lock
  TTL is hardcoded at ten seconds with no configuration, the lock id is the
  raft log index and is therefore already a fencing token, and the notify
  bus is a single global channel whose events may be replayed on restart.
  The resulting surface is small on purpose: five new calls plus backup,
  and no new primitive where an existing one composes.
---

# 032: The hiqlite interface contract

## 1. Purpose

Spec 001 §5.1 makes the addon expansion phase 2 and calls it the gate:
nothing above it is testable until it exists. A gate built from guesses is
a gate rebuilt, so this spec writes the surface down first, derived from
what the control plane will actually need.

It is a separate document from spec 001 for a reason recorded in the pivot
brief and worth repeating: this is read repeatedly during addon work,
while the thesis is read once to orient. A contract kept inside a strategy
document goes stale between writing and use.

**Everything here is checked against hiqlite's implementation, not its
docs.** That was not ceremony. Three checks changed the answer:

1. The distributed lock TTL is `const LOCK_VALID_SECONDS: i64 = 10` in
   `store/state_machine/memory/dlock_handler.rs`, hardcoded, with a
   `// TODO - lock_timeout` sitting in `client/dlock.rs`. Leases are ten
   seconds and not configurable, which is a constraint on controller
   design rather than a tuning knob (§3.4).
2. The lock id is the raft `log_id` (`LockRequestPayload.log_id`),
   monotonically increasing across the cache raft group. A fencing token
   already exists and is free (§3.4).
3. `listen` is one global channel (`rx_notify`), not per-topic, and its
   own doc comment warns that "cache events may be replayed" after a
   restart, which is why `listen_after_start` exists. Filtering and
   idempotence are the consumer's job (§3.2, §3.5).

## 2. Territory

This spec owns `backend/state/`: the typed, governed facade over the
expanded addon, in the same shape as `backend/kernel/hiq.ts` (spec 021).
Application code never imports the addon; it calls this facade, and the
facade adjudicates before crossing into Rust. The extraction ban-list
enforces that, as it already does for the cache surface.

The addon itself is statecrafting's (its spec 003). This spec is the
requirement side of that interface; the addon is the implementation side.
Where the two disagree, this document is the defect report.

## 3. The ten decisions

### 3.1 Atomicity boundary

**Question.** What may commit together, and does that make `txn` required
or optional?

**Resolution.** A resource write and its outbox row commit in **one
`txn`**. The notify is issued after, outside the transaction. `txn` is
**required**, not optional.

**Reason.** SQL writes and notify land in different Raft groups (spec 001
§4.7: `RaftType::Sqlite` and `RaftType::Cache`), so they cannot be atomic
with each other under any API. That leaves exactly one atomic unit worth
having, and it is the one that matters: if a resource is durably written
and its outbox row is not, the event is lost with no trace, which is the
precise failure the outbox exists to prevent. hiqlite's `txn`
(`client/transaction.rs`) submits a batch as a single raft operation,
which is what makes this available at all.

**Determines.** `txn(statements): Promise<ExecuteResult[]>` is on the
surface, and it is the write path for anything with an invariant. Single
`execute` remains for writes with no companion row.

### 3.2 Notify envelope

**Question.** Key-only `{kind, tenant, name, revision}`, or full payload?

**Resolution.** **Key-only.** The envelope carries what is needed to
decide whether to re-read, and nothing else.

**Reason.** Three, and each is sufficient on its own. The cache raft group
is replicated to every node and is not durable, so a large payload costs
memory on every node for data no one may trust. The payload is already
durable in the SQL group, so shipping it twice buys nothing. And a full
payload tempts a consumer to act on delivery, which is incorrect because
delivery is not guaranteed (§3.5); a key-only envelope makes the re-read
structural rather than disciplined.

**Determines.** `notify(envelope)` and `listen()` carry a fixed, small
shape. Because hiqlite's listen channel is global rather than per-topic,
the envelope's `kind` is also the routing key, and filtering happens in
`backend/state/`.

### 3.3 Read consistency

**Question.** Admission needs linearizable reads; hot policy evaluation
wants the local replica. One call with a flag, or two calls?

**Resolution.** **Two distinct calls.** `query()` reads the local replica.
`queryConsistent()` takes the leader round-trip.

**Reason.** A single call with a consistency flag has a default, and the
default is silently wrong at half the call sites. Two names force the
author to state the requirement, and make the expensive one visible in
review. hiqlite already draws exactly this line (`query_consistent` versus
`query_map` / `query_raw`), so this is surfacing an upstream distinction
rather than inventing one.

**Determines.** Admission and the Decision chain head read use
`queryConsistent`. List and detail endpoints, policy evaluation, and
controller scans use `query`. The facade names them so the two never blur.

### 3.4 Lease semantics

**Question.** TTL plus fencing token, or a bare lock?

**Resolution.** **Fencing token, mandatory**, and the TTL is not ours to
choose: it is ten seconds.

**Reason.** This is the decision the implementation check changed. The
intended answer was "TTL plus fencing token, tuned per controller". The
TTL is `const LOCK_VALID_SECONDS: i64 = 10` and there is no configuration
path, so every lease expires in ten seconds whether or not the holder is
finished. A controller whose reconcile exceeds ten seconds therefore
**loses its lease while still running**, and its replacement starts work
concurrently. That is not an edge case to document; it is the normal case
for any non-trivial reconcile.

Fencing is therefore not optional hardening, it is what makes the lock
usable at all. The good news is that it is free: the lock id is the raft
`log_id`, monotonically increasing across the cache group, so it is
already a valid fencing token. Every lease-guarded write carries it, and
the store rejects a token below the highest seen for that key:

```sql
UPDATE resource SET ..., fence = :token
 WHERE id = :id AND fence <= :token
```

A zombie holder's writes fail this predicate and it learns it has been
superseded. Enforcement is a SQL predicate at the call site, not addon
machinery.

**Two further constraints.** Lock state lives in the cache raft group, so
it does not survive a full cluster restart, which is correct for leases
and must not be relied on for anything else. And hiqlite's `Lock` releases
on `Drop`, asynchronously via `task::spawn`; JavaScript has no
deterministic drop, so the addon must hold the Rust `Lock` in a handle and
expose **explicit `release()`**, with the handle's own finalizer as a
backstop rather than the mechanism.

**Determines.** `lock(key): Promise<{ token: bigint, release(): Promise<void> }>`.
Controllers chunk their work to fit inside ten seconds, or re-acquire and
rely on fencing. Both are legitimate; pretending the lease is long is not.

### 3.5 Watermark

**Question.** How does a controller detect a missed notify, and does that
require a sequence generator in the addon?

**Resolution.** A **monotonic revision column**, maintained inside the
same `txn` as the resource write. Controllers persist their
last-processed revision and, every tick, query for `revision > watermark`
whether or not a notify arrived. **No new addon primitive.**

**Reason.** Notify is a hint and revision is truth (spec 001 §4.7), and
hiqlite's own listen documentation confirms events may be replayed after
a restart, so a consumer must be idempotent and self-healing regardless.
Once the poll exists for correctness, the notify only shortens latency,
and a dedicated sequence API would be a second source of ordering to keep
consistent with the first. Writes are serialized through the raft leader,
so `max(revision) + 1` computed inside the transaction is already
correct, and it lands in the same atomic unit as the row it stamps.

**Determines.** Nothing on the addon surface. This decision's value is
that it removes a call rather than adding one.

### 3.6 Migration ownership

**Question.** Leader-only, applied through raft, versioned. Does the
addon expose a migrate entry point?

**Resolution.** **No entry point.** Migrations are DDL submitted through
`txn`, guarded by a `schema_version` table read with `queryConsistent`,
run as a deploy step rather than a boot step (spec 027).

**Reason.** Leader-only is not something to implement: every write already
goes through the leader, so it is a property of the store rather than a
feature of the migrator. What remains is version comparison, ordering, and
idempotence, which is policy, and policy belongs in application code where
it is testable and reviewable. An addon entry point would freeze that
policy into a binary that ships on a different cadence.

Boot-time migration is refused for a specific failure: N replicas booting
together would each attempt it, and the losers' behavior on a partially
applied schema is undefined. A deploy step has one runner by construction.

**Determines.** Nothing on the addon surface.

### 3.7 CAS and audit placement

**Question.** The Decision chain needs linearizable read-modify-write on
the chain head, which argues for hiqlite. Audit history is unbounded,
which forbids hiqlite (spec 001 §4.7: the full database replicates to
every node). Both are true. Does the addon need a compare-and-swap
primitive distinct from `txn`?

**Resolution.** **The head plus a hot window live in hiqlite; sealed
segments archive out.** And **no new CAS primitive**: `txn` plus a unique
index is the CAS.

**Reason.** The two requirements are not actually in conflict, because
they apply to different parts of the same structure. Linearizable
read-modify-write is needed only at the head. Unboundedness is a property
only of the tail. Splitting at that seam satisfies both.

The CAS answer is better still: `backend/kernel/decisions.ts` already
implements it, and the design survives. A unique index on the parent
pointer makes the insert itself the compare-and-swap, because a second
writer claiming the same parent violates the constraint and surfaces as a
retryable error. Inside a `txn` on a single-writer raft group that is
exactly a CAS, with no new primitive and no new failure mode. Spec 024's
three-attempt retry loop carries over unchanged.

**Sealing.** When the hot window exceeds its bound, the oldest contiguous
run is sealed into a segment: a segment record (first id, last id, count,
segment hash, previous segment hash), the segment body written to the
archive, then the archived records deleted from the hot table. Each
segment links to its predecessor's hash and the surviving head links to
the last segment, so the chain verifies end to end **without archived
history being resident**. Verification of the resident portion stays
exactly as fast as it is today.

**Determines.** No new addon call. It determines a schema and a sealing
controller, both application-side.

### 3.8 Backup surface

**Question.** What does the addon expose, and can the platform trigger a
backup before a risky operation?

**Resolution.** `backup()`, `backupListLocal()`, `backupListS3()`.
Restore is deliberately **not** on the addon surface: it is a boot-time
concern (§3.9). Yes, the platform can trigger a pre-upgrade backup, and
that is the reason the on-demand call is in scope at all.

**Reason.** The scheduled cron backup alone cannot bracket a risky
operation, and bracketing is the difference between an RPO equal to the
cron interval and an RPO equal to zero for the operations that actually
threaten data. Upgrades, migrations, and bulk imports each get a backup
immediately before.

The upstream calls are safe to expose as they are: `create_backup` issues
`VACUUM main INTO` on the writer thread, so it is serialized against
writes rather than racing them, leader-only, with a sixty-second duplicate
request guard.

**Determines.** Three calls, thin wrappers, plus the `backup` cargo
feature (which resolves to `["dep:cron", "s3", "sqlite"]` and therefore
arrives with the sqlite feature rather than costing extra).

### 3.9 Archive mechanics

**Question.** Archived audit segments and hiqlite backups are both
durability surfaces. Are they the same mechanism?

**Resolution.** **No, and they must not be conflated in code or in the
tenant assurance.**

| | hiqlite backup | archive segment |
|---|---|---|
| What | encrypted point-in-time snapshot of the whole SQLite group | one immutable slice of audit history |
| Granularity | all or nothing | per segment |
| Verification | `_metadata` table integrity check | hash link to the predecessor segment |
| Retention | operational, `HQL_BACKUP_KEEP_DAYS` | compliance schedule, typically far longer |
| Loss means | recent state is gone back to the last snapshot | one chain link is missing, and it is detectable |
| Restore | cluster reset (§3.10 note) | read the object, verify the link |

**Reason.** They answer different questions and fail differently. A
procurement review that is told "your audit history is backed up" and
discovers the retention is thirty operational days has been misled, and a
grant auditor asking for three-year-old board decisions is not served by a
snapshot schedule. Keeping them separate in code is what keeps them
separate in the assurance.

**Restore is a cluster reset, not a data restore**, and that belongs in
spec 027 with its own runbook. `restore_backup` is documented "MUST BE
CALLED when the Raft is not running", and it removes `path_db`,
`path_snapshots`, `path_lock_file`, and `path_logs`: the raft log, not
just the state machine. At N=1 that is stop, restore, start. At N>=3 it is
stop the cluster, restore on one member, discard the others' state
entirely, restart, and let them rejoin by full snapshot transfer. Purging
the log is what forces snapshot transfer rather than incremental catch-up,
so the re-replication window scales with database size. The
`debug_assert!` that node 1 is the leader compiles out in release builds:
it documents an expectation and enforces nothing, which is why the runbook
is load bearing.

**`HQL_BACKUP_RESTORE` is designed out, not documented around.** Left set
in a container with a restart policy, it re-applies the backup on **every**
restart and discards everything written since, turning a crash loop into
silent repeated data loss. Restore therefore routes through
`docker/first-boot.mjs`, which writes a marker into the volume recording
which backup was applied and refuses to re-apply it. The operator sets the
variable once; the platform makes it single-shot. That marker is phase
1b's work, which is why phases 1a and 1b are sequenced together.

**Determines.** No addon call. It determines the archive object format,
the first-boot marker, and a boundary in the tenant assurance.

### 3.10 Local notify only

**Question.** hiqlite offers `listen_notify` (remote SSE listeners for
non-member clients) alongside `listen_notify_local`. Which?

**Resolution.** **`listen_notify_local` only.**

**Reason.** A remote listener lets a client subscribe to the cache raft
group directly over SSE. That is a second egress path out of a governed
deployment, and it bypasses the API layer where admission runs. Spec 030
§3.5 already made this argument for pub/sub and reached the same place:
a governed deployment whose messages leave unadjudicated has an ungoverned
channel, and the whole kernel plane becomes arguable. Client-facing
streaming is Encore `TypedStream` (tier 2 of the event model), which runs
through the API layer and is adjudicated like any other request.

The cost is nil: `listen_notify_local` resolves to `["cache"]`, which is
already enabled.

**Determines.** The cargo feature list, and one fewer network surface.

### 3.11 The auth boundary

Decided at thesis level in spec 001 §5.3 and restated here for its
consequence on this surface: rauthy owns authentication and principal
identity, this model owns authorization bindings joined on `sub`, and the
app derives its session from rauthy's rather than minting its own refresh
tokens.

**Determines.** There are **no session or refresh-token tables in the
state layer.** `UserAccount` and `RefreshToken` retire with spec 004's
rewrite. `AuditLog` does not retire with them: it is application data that
outlives the auth change, and it is distinct from the Decision chain
(§3.7), which records adjudication rather than domain mutation.

## 4. The resulting surface

Small on purpose. Five new calls plus three backup calls, and no new
primitive anywhere an existing one composes. Four of the ten decisions
add nothing to the addon at all.

```ts
// reads: the consistency choice is in the name, never a flag (§3.3)
query<T>(sql: string, params?: SqlValue[]): Promise<T[]>
queryConsistent<T>(sql: string, params?: SqlValue[]): Promise<T[]>

// writes: txn is the write path for anything with an invariant (§3.1)
execute(sql: string, params?: SqlValue[]): Promise<ExecuteResult>
txn(statements: SqlStatement[]): Promise<ExecuteResult[]>

// watch: key-only envelope, global channel, consumer-side filtering (§3.2)
notify(envelope: NotifyEnvelope): Promise<void>
listen(handler: (e: NotifyEnvelope) => void): Unsubscribe

// leases: ten seconds, fencing token mandatory, explicit release (§3.4)
lock(key: string): Promise<Lease>            // Lease = { token, release() }

// durability (§3.8)
backup(): Promise<void>
backupListLocal(): Promise<BackupListing[]>
backupListS3(): Promise<BackupListing[]>
```

Cluster configuration passthrough, not new consensus code: `node_id`,
`nodes`, `secret_raft`, `secret_api`, `data_dir`, `learner_only`. hiqlite
already solves bootstrap, auto-join, ordinal identity
(`node_id_from = "k8s"`), and learners (`HQL_LEARNER_ONLY`).

Cargo features to add: `sqlite`, `dlock`, `listen_notify_local`, alongside
the existing `cache`, `counters`, `macros`. The last two resolve to
`["cache"]` and are nearly free; `sqlite` is the one with a real cost
(§5).

## 5. The cost being accepted

Enabling `sqlite` pulls `rusqlite`, `deadpool`, and `serde_rusqlite`, so
SQLite-C compiles into the `.node` on all three platforms. This ends the
addon's current no-bundled-SQLite-C property, which its `Cargo.toml`
states as a design choice, and it is accepted deliberately rather than
absorbed quietly.

Two consolations, both real. `backup = ["dep:cron", "s3", "sqlite"]`, so
scheduled encrypted off-box backups arrive in the same change and they are
the product's durability story rather than a side effect. And the app
already runs SQLite through libSQL today, so the process is not gaining a
SQLite it did not have; it is consolidating onto one.

## 6. Acceptance

1. Every decision above is either implemented in the addon or recorded as
   a deviation with a reason. The addon's TS declarations match §4.
2. `txn` submits its statements as one raft operation: a test writes a
   resource and an outbox row, kills the process mid-batch, and observes
   both present or both absent, never one.
3. `query` and `queryConsistent` are separately observable: a follower
   read returns stale data under a partition where the consistent read
   blocks or fails.
4. A lease-guarded write with a stale fencing token is rejected by the SQL
   predicate, and the holder learns it was superseded. A test holds a lock
   for longer than ten seconds and proves the second holder's writes win.
5. `release()` is synchronous from JavaScript's perspective: the lock is
   observably free to another caller after the promise resolves, without
   waiting on a finalizer.
6. A missed notify does not stall a controller: with notify suppressed
   entirely, the watermark poll still converges.
7. The Decision chain's CAS behavior is unchanged: spec 024's existing
   tests pass against the new store with no change to their assertions.
8. A sealed segment verifies against its predecessor's hash with the
   archived body absent from the local store, and the resident chain still
   verifies end to end.
9. `backup()` is callable on demand and appears in `backupListLocal()`.
10. The addon exposes no restore call, and `HQL_BACKUP_RESTORE` cannot
    re-apply on a second boot (phase 1b's marker).

## 7. Out of scope

- The addon implementation: statecrafting's spec 003, phase 2.
- Secret distribution, sealing, envelope encryption, and rotation.
  Deferred deliberately: done badly it is worse than not shipped.
- Durable execution and replay (Temporal-shaped). The scope discipline is
  state machines, not durable execution: a `Run` is a resource with
  explicit `Step` records reconciled by a controller. Replay drags in
  determinism and code versioning and is a product on its own.
- Remote notify listeners (§3.10).
- A configurable lock TTL. It requires an upstream change to hiqlite
  (`// TODO - lock_timeout`); until then ten seconds is the contract and
  fencing is what makes it safe.
- The control plane that consumes this surface: phase 3.
