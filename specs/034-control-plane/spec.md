---
id: "034-control-plane"
title: "The control plane: kinds, admission, watch, controllers, audit"
status: approved
created: "2026-07-29"
implementation: complete
depends_on:
  - "001-enrahitu-architecture"
  - "020-app-model-contract"
  - "021-kernel-native-consumption"
  - "024-decision-chain-integrity"
  - "032-hiqlite-interface-contract"
establishes:
  - { kind: directory, path: "backend/control/" }
summary: >
  Phase 3 of the pivot (spec 001 §5.1), and the layer spec 001 calls
  "application code holds intent and reconciliation". Typed, tenant-scoped
  resources admitted through the kernel onto the state layer, a change feed
  ordered by a single global revision, leased and fenced reconcile loops, and
  an admission record on the Decision chain. Written after building it, as
  the phase plan requires: two of its load-bearing properties are answers to
  defects that only a running node produced, and neither was visible from the
  design. The store binds SQL parameters in order of first appearance and
  ignores the number, which silently mis-binds any statement whose numbers do
  not ascend; and an admission that changes nothing must not produce a
  revision, or a controller that writes what it watches re-triggers itself
  until its lease expires.
---

# 034: The control plane

## 1. Purpose

Spec 001 §4.1 divides the substrate into four layers with no overlap, and
gives application code "intent and reconciliation". Specs 032 and 002 built
the layer beneath: a durable, replicated store reached through a governed
facade. This spec is what sits on it, and it is the last general-purpose
layer before the association domain (phase 5) becomes ordinary application
code.

It is deliberately the shape Kubernetes made ordinary: desired state is a
row, observed state is a status, and a controller converges the second toward
the first, repeatedly. That is not imitation. It is the only shape that
survives the two properties this substrate actually has, both of which are
recorded in spec 032 rather than chosen here: **a lease that expires in ten
seconds whether or not its holder is finished**, and **a notify that is a
hint rather than a delivery**. Any design in which a change is applied once
and assumed to have taken is wrong under either one.

## 2. Territory

`backend/control/`: `kinds`, `admission`, `watch`, `controller`, `schema`,
`rows`, and the barrel. Plus a `control` service in `app-manifest.json`,
`role: library`, holding six grants.

It publishes no endpoints, for the same reason the state layer publishes
none: the association domain publishes them, and each of those runs under its
own service's kernel attribution, so a member-facing handler cannot borrow
the control plane's ceiling by calling through it.

It holds no addon import. Every store crossing goes through `backend/state/`,
which adjudicates it (spec 032).

## 3. Behavior

### 3.1 One table, and a revision assigned inside the transaction

Resources live in one `resource` table with `kind` as a column, keyed
`(kind, tenant, name)`.

A table per kind would let a grant's `tables` constraint narrow to one kind,
which is real and is the argument against this. It loses to a stronger one:
kinds are data, not DDL. A kind registered at runtime with no migration is
what makes phase 5 additive rather than a schema change per resource type,
and it is what keeps the watch a single ordered scan instead of a fan-in over
N tables whose revisions would then have to be merged into one order.

`revision` is a single monotonic sequence across every resource, because a
controller's scan is `revision > watermark ORDER BY revision` over everything
it watches, and a per-resource counter cannot answer that question.

**It is computed as `MAX(revision) + 1` inside the admitting transaction**,
and the alternative deserves recording because it is the obvious one and it
is wrong. Bumping a sequence row first and writing with the value it returned
takes two raft operations, so two writers interleave: W1 takes revision 5, W2
takes 6, W2 commits, W1 commits. A watcher polling between those commits sees
6, advances past 5, and never sees W1's write. Computing inside the
transaction makes revision order and commit order the same order, because raft
serializes the transactions, and that identity is the entire basis of the
watermark's correctness.

Deletes are therefore soft. A hard delete could lower `MAX(revision)` and hand
a later write a revision a watcher had already passed. A tombstone is also
what a watcher needs in order to observe a deletion at all: a row that
vanishes is indistinguishable from one it never saw.

### 3.2 Kinds

A kind is a name, a tenancy decision, and a validator. It is not a schema
language and not an ORM mapping: `spec` is stored as JSON and the validator is
the only statement of what that JSON may be.

The validator returns the normalized value rather than a boolean. A predicate
would let a caller admit the unnormalized input it was handed, which is the
usual route by which a "validated" record ends up holding untrimmed
whitespace. Normalization is also load-bearing for §3.3's no-op rule: two
inputs that normalize to the same resource must compare equal, or a converged
controller never becomes quiescent.

Cluster-scoped kinds store `''` as their tenant rather than NULL, because
tenant is part of the primary key and SQLite does not treat NULLs as equal, so
a nullable column would admit duplicate rows for the same resource.

Registering the same name twice with a different definition is a refusal.
Otherwise admissibility would depend on module load order, and the resulting
defect appears as data that was valid on Tuesday.

### 3.3 Admission

Five steps, in this order:

1. **validate** the spec through the kind's validator
2. **adjudicate**, which the state facade does before crossing into Rust, so a
   denial costs no write
3. **commit** the resource row and its outbox row in one `txn` (spec 032 §3.1)
4. **read back** the revision the row actually got
5. **notify**, after the commit, never inside it

Step 5 is after step 3 because SQL writes and notify land in different raft
groups and cannot be atomic with each other under any API (spec 032 §3.1). A
notify issued inside the write path would announce a commit that might not
happen. Issued after, the worst case is a commit whose notify is lost, which
§3.4's scan recovers from by design.

**An admission that changes nothing produces no revision.** If the normalized
spec and the fence both match what is stored and the row is not a tombstone,
the existing resource is returned unchanged: no write, no outbox row, no
notify. This is not an optimization. Without it the control plane does not
work: a controller that writes a resource it also watches sees its own write
as a new revision, reconciles again, writes again, and spins until its lease
expires. The rule was found by a test that timed out, not by review, and it is
recorded here because "converged means quiescent" is invisible in the code
that implements it.

**Fencing** is the caller's token from a held lease, checked twice: once
against the stored high-water mark before the write, and once as a SQL
predicate inside it (`WHERE fence <= excluded.fence`). A write below the mark
raises `SupersededError`, which is how a controller that lost its lease
mid-reconcile learns it was superseded rather than silently losing.

**Capability granularity is the store, not the kind.** Admission's check is
the state facade's `db.txn` on `state`. Per-kind grants would be better and
are deliberately absent: the kernel's narrowing axis for `db.*` is the
`tables` constraint, every kind shares one table (§3.1), so the axis buys
nothing as the schema stands, and making a kind its own capability resource is
a contract question about the model rather than an implementation one. Spec
020 §3.4 already carries per-verb and per-table attribution as a named v0.2
extension; per-kind admission grants belong on that list, and phase 4 is where
the boundary work meets it.

### 3.4 The watch

A change feed over the global revision: `revision > watermark ORDER BY
revision`, bounded by a batch size, read from the local replica.

**The poll is the mechanism and the notify is an optimization.** Inverting
that is the standard way to build a change feed that works until it silently
does not: hiqlite replays cache events after a restart, delivers each event to
one awaiter, guarantees nothing, and crosses a different raft group than the
write (spec 032 §3.2, §3.5). A watcher here is correct with the notify pathway
entirely dead. The notify only wakes the scan early, turning "up to one tick"
into milliseconds.

The local replica, not the leader: a watcher that lags is behaving correctly,
and paying a leader round trip per scan would put every controller's
steady-state polling on the leader (spec 032 §3.3).

The waker subscribes **before** the scan runs, not after. Subscribing after
would drop every notify issued during the scan, which is exactly the window a
busy store fills.

### 3.5 Controllers

A controller is a leased, fenced, watermarked loop. The ten-second lease is
the shape of it:

- A pass takes a budget well under the TTL (7s by default) and stops at the
  deadline, mid-batch if necessary, rather than finishing what it started.
- Every write a reconciler makes carries the pass's fencing token, so a pass
  that overran anyway is rejected by the store rather than by luck.
- The watermark is durable, so a pass that stopped early simply resumes.

The three-second gap between the budget and the TTL is the allowance for the
last reconcile, which starts inside the budget and may finish outside it. A
reconciler that can exceed three seconds is expected to consult
`remainingMs()`.

**Reconcilers must be idempotent, and the loop does not pretend to help.** The
watermark advances once per batch, so a crash mid-batch replays that batch.
Advancing per item would cost a write per change and still not give
exactly-once, because the reconcile and the watermark write are two operations
in different transactions. Idempotence is required anyway: hiqlite replays
cache events after a restart.

A failing reconcile is logged and the loop continues. A controller that exits
on its first error is down after the first transient, and everything it
reconciles is expressed as converge-toward-desired rather than apply-once.

### 3.6 The parameter-binding constraint

**hiqlite binds parameters to placeholders in order of first appearance and
ignores the number.** `$1` and `$2` look like numbered binding and behave like
positional binding, so any statement whose numbers do not ascend by first
appearance binds the wrong values, with no error and no warning:

```sql
-- params: ["A", "B"]
SELECT * FROM t WHERE b = $2 AND a = $1   -- binds b := "A", a := "B"
```

This cost two silently empty tables and a tombstone that never appeared before
it was isolated, and none of the three symptoms looked like a binding problem.
An `INSERT ... SELECT` inserted nothing; an `UPDATE` reported zero rows.

The rule every statement must obey: the first occurrence of each distinct
placeholder is numbered 1, 2, 3, ... in the order it appears. Re-using an
already-seen number later is fine and is the normal way to use one value
twice.

`backend/state/placeholders.ts` enforces it on every statement crossing the
facade, so the failure is now a thrown error naming the statement rather than
wrong data. The scanner skips single-quoted literals, including SQL's
doubled-quote escape, so `'costs $5'` is not read as a placeholder.

The addon should bind by number, and this is filed against statecrafting spec
003. Until it does, the guard is the contract.

### 3.7 Audit

Admission appends an allow to the Decision chain, alongside the denials the
kernel already appends (spec 021 §3.6).

A ledger holding only denials answers "what was stopped" and cannot answer
"who changed this", which is the question a board minute or a grant audit
actually asks, and spec 001 §4.1 names those as the buying reasons.

`contextHash` is exported from `backend/kernel/decisions.ts` for this, rather
than reimplemented: a second answer to what a record commits to is one the
chain's verification cannot adjudicate between.

The Decision store stays CoreLedger's. Moving the chain head onto hiqlite with
sealing and archive (spec 032 §3.7, §3.9) is a distinct change with its own
risk, and spec 024 owns it.

## 4. Acceptance

1. A kind's validator normalizes rather than approving, and an invalid spec is
   refused naming the field, before any write.
2. Tenancy holds in both directions: a tenant-scoped kind refuses admission
   without a tenant, a cluster-scoped one refuses admission with one, and two
   tenants may hold the same resource name.
3. Revisions increase strictly across kinds and tenants, and every resource
   write has an outbox row at the same revision.
4. Re-admitting an unchanged spec produces no new revision and no outbox row.
5. A retraction is a tombstone: absent from `get` and `list`, present to the
   watch with `retracted: true`, and retracting twice is a no-op.
6. A write carrying a fence below the stored mark is refused and the stored
   value is unchanged.
7. A controller reconciles every pending change, records a durable watermark,
   and replays nothing on its next pass.
8. A reconciler receives a real fencing token and can write through it.
9. A throwing reconciler leaves the watermark unadvanced, and the change is
   still pending for the next pass.
10. A service without the state grants is denied admission, and the control
    plane is denied the schema change it does not hold.

All ten are asserted in `backend/control/control.test.ts` against a booted
node.

## 5. Out of scope

- **The association domain.** Phase 5. This spec is the machinery; members,
  tiers, dues and events are kinds registered on it.
- **The Decision chain's migration to hiqlite**, its hot window, and segment
  sealing (spec 032 §3.7, §3.9). Spec 024's territory.
- **Per-kind capability grants** (§3.3), which need the model to carry kinds.
- **HTTP endpoints.** The domain publishes them; §2 records why not here.
- **Status subresources with their own optimistic concurrency.** `status` is a
  column a controller writes through the same admission path. Splitting it
  into an independently versioned subresource is a real design, and it is not
  needed until two writers contend for one resource's status.

## Amendment (2026-07-30): the status-write path (spec 036)

§5 recorded that "`status` is a column a controller writes through the same
admission path" and left splitting it into a subresource out of scope. The first
consumer found that the admission path had no such write: `admit`'s `ON
CONFLICT` clause sets `revision`, `fence`, `spec`, `deleted_at`, and
`updated_at`, so `status` was readable and unwritable by anything in the tree.

`setStatus(kind, name, status, opts)` closes it, as the same five steps of §3.3
in the same order. Validation is skipped, because status is the controller's own
shape rather than the kind's declared one, and giving the kind registry a second
validator vocabulary would make a kind describe two things. Everything else
holds unchanged: the state facade adjudicates before the crossing, the row and
its outbox row commit in one `txn` at one revision, the revision is read back,
and the notify follows the commit.

**§3.3's no-op rule extends to it verbatim, and for a sharper reason.** A
controller that writes status to a kind it also watches is not an edge case here;
it is the normal shape of every reconciler the domain has. Without the rule each
reconcile would produce the change that triggers the next one, which is the same
spin §3.3 records, reached by a different route.

Fencing uses the row's existing mark rather than a second column. A
`status_fence` would be more precise, needs a migration, and is not yet earning
it: spec 036 §3.4 shows that one mark behaves correctly for both writers once an
endpoint passes the fence it read. The subresource in §5 remains the answer for
when two controllers contend for one status, and that has still not happened.

## Amendment (2026-08-06): the loop waits for its schema (spec 028's item 4)

Writing the operator manual found a defect this spec owns and recorded it there
rather than documenting it away (spec 028's amendment, item 4). This closes it.

**The symptom.** A freshly provisioned cell has no control-plane schema, because
migration is a deploy step and never a boot step (spec 032 §3.6). Every
controller nonetheless started immediately, read `controller_watermark` on its
first pass, threw `no such table: controller_watermark`, logged it, slept one
tick, and repeated. The out-of-box state of a new cell was a permanent error
loop at roughly 1 Hz, and it lasted until an operator ran `migrate --apply`.

**What was actually wrong was the altitude of the check, not its absence.** Spec
036 §3.6 had already required exactly this behavior and `backend/members/boot.ts`
already implemented it, waiting for the schema before starting its controller.
The mail runtime, arriving later, did not, because nothing in `startController`
required its caller to have thought about it. A precondition that each caller
must remember is a precondition each new caller will eventually forget, and the
second one already had.

The wait therefore moves into the loop that holds the precondition:

- `startController` waits for the control-plane tables before its first pass. It
  says so once and then says nothing, rather than reporting a fault per tick.
  A controller written tomorrow inherits this without its author knowing.
- The waiter is cancellable, so `stop()` does not have to outlast a poll
  interval. A shutdown that hangs for five seconds reads as a shutdown that hung.
- A failing probe keeps waiting and reports through a distinct log line. The
  loops previously caught every store error per pass and continued; a gate that
  propagated one would have turned a transient into a permanently dead
  controller, which is a worse failure than the noise being removed, and silent.

**A missing precondition is a state, not a fault**, and the distinction is the
whole of it. The old loop was not wrong about the facts: the table really was
absent and the pass really did fail. It was wrong about what kind of thing that
was, and an error per second addressed to an operator who cannot act on it any
faster than once teaches that operator to stop reading the log, which is the
condition under which the next real error is invisible.

**`runOnce` needed its guarantee written down.** It runs one pass by calling
`startController` and stopping it immediately, which worked because the loop
reached its first `pass()` inside the synchronous prefix, before
`startController` returned. Awaiting the schema yields before that, so the
one-pass guarantee evaporated and three existing tests in this spec's suite
failed. The loop is now a `do`/`while`: one pass runs once the gate opens, even
if a stop was requested while it was waiting. The behavior is unchanged and is
no longer a property of scheduling.

`backend/control/schema-gate.test.ts` covers it against a node whose migration
has never been applied, which is the only state in which the property is
visible. Its first draft asserted that no reconcile ran and the watermark stayed
at 0, and passed against the unfixed code: the old loop threw several statements
before anything a reconciler would see, so both were true while it failed forty
times a second. The assertion is on the log, because the log is the defect.
