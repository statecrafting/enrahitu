---
id: "027-operational-verbs"
title: "Operational verbs: preflight, migrate, backup, restore"
status: approved
created: "2026-07-25"
implementation: in-progress
depends_on:
  - "003-coreledger"
  - "007-single-container-packaging"
  - "009-template-contract"
  - "011-coreledger-postgres-driver"
establishes:
  - { kind: directory, path: "scripts/ops/" }
summary: >
  The template contract can stamp an app, verify it, and package it. It
  has no vocabulary for running one over time. There is no backup or
  restore anywhere in the tree, no verb, and no documentation; the
  migration runner spec 011 landed has no caller outside its own tests,
  so a stamped app upgrading from v1 to v2 has no defined moment when
  schema changes apply. This spec adds four verbs to template.toml
  (contract v0.8.0) and their implementations. The backup design is
  shaped by what each of the four state classes on the volume actually
  is: CoreLedger snapshots online through VACUUM INTO, rauthy's identity
  store is captured through rauthy's own integrity-checked backup
  mechanism rather than by copying raft directories, the app's hiqlite is
  captured through the addon's own `backup()` for exactly the same reason,
  and key material is bound into the same archive because either encrypted
  store restored without its matching keys is unrecoverable. Amended
  2026-08-04, before implementation: the first revision excluded the app's
  hiqlite as derived cache state and the pivot made that false, so §3.8
  records what the unamended spec would have shipped and why it read as
  correct on the day it was written.
---

# 027: Operational verbs

## 1. Purpose

`template.toml` exposes `verify`, `package`, and `scaffold`. Those are
build-time verbs. A fleet operating stamped apps on customer hardware
needs run-time verbs, and the template offers none.

The gap is widest at backup. A grep for backup or restore across
`backend/`, `docker/`, `scripts/`, `specs/`, `docs/`, `.github/`, and
`template.toml` returns nothing. For a substrate whose entire pitch is
that all durable state lives on one volume, "how do I back it up" is
the first question any operator asks, and the honest current answer is
that they have to work it out themselves.

Working it out is harder than it looks, which is why leaving it
undefined is a real defect rather than a missing convenience. One
volume holds four things with four different consistency requirements:

1. `/data/ledger/enrahitu.db` plus its WAL: the application's CoreLedger
   store, including the `kernel_decisions` hash chain that spec 024 made
   load bearing.
2. `/data/hiqlite`: the app's in-process hiqlite raft log and state
   machine.
3. `/data/rauthy/db`: rauthy's embedded hiqlite, holding every user,
   client, and session.
4. `/data/keys/*`, `/data/rauthy/secrets.env`, `/data/rauthy/admin-password`:
   PEM key material and generated secrets.

`tar /data` on a running container is a consistent backup of none of
them. Worse, the failure is silent: the archive restores, the container
starts, and the damage surfaces later.

The second gap is quieter. `backend/core/ledger/migrations.ts` is a
correct forward-only runner, and `migrate()` has no non-test caller
anywhere in the tree. Only `ensureSchema()` runs at boot
(`ledger.ts:47`), which is create-if-not-exists and cannot evolve a
column. A stamped app therefore has a migration mechanism and no moment
at which it runs.

## 2. Territory

This spec owns `scripts/ops/`: the four verb implementations, as node
scripts consistent with the existing `scripts/` conventions
(`first-boot.mjs`, `stamp.mjs`).

It amends, without owning:

- `template.toml` and spec 009: four new `[verbs]` entries, contract
  version to 0.7.0 (additive keys, a minor bump under spec 009 section
  3.1).
- `docker/entrypoint.sh` (spec 007): the pre-flight call described in
  section 3.5.
- `backend/core/ledger/` (specs 003 and 011): the migration list the
  `migrate` verb executes gains a declared home; the runner itself is
  unchanged.

## 3. Behavior

### 3.1 What is on the volume, and what each class actually needs

The design follows from the classification, so it is stated first.

**CoreLedger** is SQLite through libSQL. `VACUUM INTO '<path>'` produces
a consistent, fully-checkpointed copy of a live database without
stopping writers, which is exactly the primitive needed. This is the
only class the substrate snapshots itself.

When `ENRAHITU_LEDGER_URL` names a Turso replica or a Postgres server
(spec 011), the authoritative copy is not on this volume and its backup
belongs to that provider. The verb detects the URL scheme, states this,
and backs up only what it owns. It does not pretend to have captured a
remote database.

**The app's hiqlite is the primary store and is captured through the
addon, not around it** (amended 2026-08-04; §3.8 records the supersession).
`/data/hiqlite` holds the `resource` table, which is every member, tier,
membership, dues invoice and mail notice, and every meeting, motion and
ballot once spec 038 is built. It is the association's data. A backup that
omits it is not a backup of anything a buyer would recognise.

`backup()` is the primitive, and it is the same argument rauthy's is:
hiqlite issues `VACUUM main INTO` on its writer thread, so the snapshot is
serialized against writes rather than racing them (spec 032 §3.8). Copying
`/data/hiqlite` would capture a raft log mid-write, exactly as copying
`/data/rauthy/db` would. Two stores, one reason, one shape.

Three properties of that primitive shape the verbs and are not incidental:

- **It is leader-only.** At N=1 the single voter is the leader and the
  question does not arise; at N>=3 the verb runs against the leader or it
  does not run, and saying so is cheaper than discovering it.
- **It covers the SQLite group only.** The cache group (KV with TTLs,
  rate-limit counters, lock state) is excluded and is genuinely derived:
  a restored cell rebuilds the cache on demand and starts every window
  fresh. That sentence is the true remainder of the paragraph this one
  replaces, and it is the reason nothing durable may be put there.
- **It has a sixty-second duplicate-request guard**, so a verb that
  retries a backup within the window gets the first one rather than a
  second, and a hot backup taken twice in a minute is one snapshot.

**And it is encrypted, which extends the key-binding argument to a second
store.** The addon's `backup` feature pulls hiqlite's `s3` feature, which
makes `enc_keys` mandatory: the node refuses to start without
`ENRAHITU_HIQ_ENC_KEYS`. So the app's snapshot is as unrecoverable without
its keys as rauthy's is without `ENC_KEYS`, and the paragraph below stops
being a fact about rauthy and becomes the invariant of the whole archive.

**rauthy's store is captured through rauthy, not around it.** rauthy
embeds its own backup mechanism: a cron task (`HQL_BACKUP_CRON`,
default `0 30 2 * * * *`), an on-demand `POST /backup` admin endpoint,
`GET /backup` to list, and `GET /backup/local/{filename}` to retrieve.
The product is a plain SQLite file carrying a `_metadata` table that
rauthy validates on restore. Using it means the identity store is
captured by the process that owns it, with an integrity check the
substrate did not have to invent. Copying `/data/rauthy/db` directly
would capture a raft log mid-write, and this spec does not do that.

**Key material binds the archive together.** rauthy encrypts data at
rest with `ENC_KEYS` from `/data/rauthy/secrets.env`, and the app's
hiqlite encrypts its snapshots with `ENRAHITU_HIQ_ENC_KEYS` from the same
file. Either store restored without its matching keys is undecryptable.
Keys and the two encrypted stores are therefore never separable: they go
into one archive or the archive is worthless. This single fact is why the
verb produces one artifact rather than letting an operator assemble parts,
and it is now true twice over, which is what makes it an invariant rather
than a property of one dependency.

Because the archive contains every secret the cell holds, it is a
secret in its entirety. The verb says so, sets mode 0600, and refuses
to write to a world-readable destination.

### 3.2 `backup`

Two modes, because the honest default and the zero-downtime path are
different tools.

**Cold (default).** The container is stopped. Every class is at rest, so
the verb copies the CoreLedger file, the app's hiqlite directory, the
rauthy data directory, and the key material, writes a manifest, and
checksums the result. No API, no credentials, no coordination. This is
always correct and is what the documentation recommends for scheduled
backups of a single cell.

Copying `/data/hiqlite` is safe **only** in this mode, and the reason is
worth stating rather than assuming: a stopped node's raft directory is
exactly the state the node would recover from on its next boot, including
after an unclean stop. A cold copy therefore captures what recovery would
produce, which is the only useful definition of "at rest". The same copy
taken while the node is running captures a raft log mid-write, which is
why §3.1 refuses it in the hot path.

**Hot (`--online`).** The container is running, and every class is
captured by the process that owns it.

- CoreLedger with `VACUUM INTO`.
- The app's hiqlite through **the admin data plane**, not through a file
  copy and not through a second process. At N=1 the embedded node holds
  the volume open, so nothing outside the app can reach the store; this is
  the same constraint that put the schema verb on the admin plane in this
  spec's 2026-07-30 amendment, and the answer generalizes rather than
  being re-derived. The verb calls an operator-gated endpoint that invokes
  `backup()` and returns the resulting file's name, then collects it.
- rauthy over `POST /auth/v1/backup`, the named file collected from
  `/data/rauthy/db`, so the identity snapshot is current as of the verb's
  invocation rather than as of rauthy's overnight cron.

The hot path therefore needs two credentials, not one: a rauthy admin API
key as `ENRAHITU_RAUTHY_API_KEY`, and an operator session for the app.
Missing either, the verb says which store it could not refresh and names
the age of what it is shipping instead, rather than silently including a
stale member. Two credentials for two stores is the same shape spec 037
§3.1 argued for two mail surfaces: sharing one would be privilege
duplication.

**The hot path has no cross-store consistency point, and the order is the
answer.** Three stores are snapshotted at three instants and nothing can
make them one, because they are three processes with three write paths and
no shared transaction. The skew is small and it is not symmetric, because
the Decision chain lives in CoreLedger and the resources those Decisions
admit live in hiqlite:

- **Chain snapshotted after the resource store**: the chain may hold a
  Decision admitting a write the resource member does not contain. The
  chain still verifies, because `verifyChain` reads `kernel_decisions`
  only (spec 036 §3.2), and the absence is visible as a Decision naming a
  resource that is not there.
- **Chain snapshotted before the resource store**: the resource member may
  hold a row whose admitting Decision is absent from the chain. That is an
  **unaudited row**, which is the single thing the kernel plane exists to
  prevent, and unlike the other direction it is invisible: nothing about
  the row says a record should have existed.

So the hot verb snapshots **the resource store first and the chain last**,
which puts the skew permanently in the direction that is detectable rather
than the direction that is silent. This costs nothing and is the whole of
the design's answer to consistency: not a guarantee, an ordering, with the
residue named. An operator who needs zero skew takes a cold backup, and
the documentation says so in those words.

Both modes emit one `.tar.gz` containing a `manifest.json` that records:
the template and contract versions, the app model hash and gate config
hash from the kernel boot receipt (spec 021), the ledger URL scheme, the
mode used, a per-member SHA-256, **a per-member captured-at instant**, and
the timestamp. The manifest is what makes the archive verifiable rather
than merely present, and the per-member instants are what make the
paragraph above auditable after the fact instead of merely promised.

### 3.3 `restore`

Refuses to run against a live container. Verifies every checksum in the
manifest before touching the volume, and refuses on any mismatch.

CoreLedger is placed as the database file. Key material is written back
at 0600. Both hiqlite stores are restored through hiqlite's own documented
path rather than by file placement: `HQL_BACKUP_RESTORE=file:<path>` on
the next start, validated against the `_metadata` table, followed by
removal of that variable. Spec 033 §3.5 already built the single-shot
half: `docker/first-boot.mjs` records which backup it honoured in a marker
on the volume and writes an `unset` into `restore.env` on every subsequent
boot, so an operator may set the variable once and leave it set without
arming a restore loop. This verb consumes that machinery rather than
inventing a second one.

**One variable, two nodes: the restore path is ambiguous today and this
verb is what forces it to be resolved.** `restore.env` is sourced by the
entrypoint before either supervised process starts, and its own comment
states the reason plainly: "both hiqlite instances would otherwise inherit
it." `HQL_BACKUP_RESTORE` is hiqlite's variable, not rauthy's, and the app
runs an embedded hiqlite too, so a single value naming a single file is
read by two independent nodes with two unrelated state machines. Whichever
one it was not meant for either refuses the file or, worse, accepts it.

That was harmless while the app's hiqlite held nothing worth restoring,
which is precisely the assumption §3.1 no longer makes. The fix is the
pattern spec 037 §3.1 already argued for mail credentials, applied to the
same file for the same reason: **the entrypoint scopes each restore
variable into exactly the subshell that should act on it**, so rauthy's
node is offered rauthy's snapshot and the app's node is offered the app's,
and neither can see the other's. `first-boot.mjs` accordingly records a
restore decision per store rather than one decision, and `restore.env`
carries two scoped exports rather than one ambient one.

`/data/hiqlite` is therefore restored and never recreated empty. The
sentence this replaces was correct for a cache and would be data loss for
a store holding the association's members.

The verb warns when the archive's model hash differs from the image's:
restoring a v1 backup into a v2 image is legitimate and common, but it
means pending migrations, and section 3.4 is the next step rather than
an implicit one.

### 3.4 `migrate`

Runs `migrate(driver, migrations)` against the configured ledger and
reports the versions applied. The migration list gains a declared home
so a stamped app has an obvious place to add to.

It is a deploy step, not a boot step. Two reasons, and the second is the
one that decides it:

1. Boot-time migration ties schema change to process restart, so a
   crash loop becomes a migration loop.
2. Once a topology runs more than one app container against one ledger
   (spec 030), boot-time migration races. The runner survives the race
   by construction, because `version` is the primary key of
   `_coreledger_migrations` and each migration shares a transaction with
   its recording insert, so a concurrent loser rolls back cleanly. But
   surviving a race is not a reason to run one, and the loser's error is
   a raw constraint violation rather than a legible message.

`ENRAHITU_MIGRATE_ON_BOOT=true` remains available for the
single-container case where the simplicity is worth it, defaulting to
false. The verb is the supported path.

### 3.5 `preflight`

Validates, before anything starts, the conditions whose absence
currently produces a confusing failure later:

- Every name in `ENRAHITU_REQUIRED_ENV` is set and non-empty (the check
  spec 007 already implements, promoted to a verb so it can run outside
  the entrypoint).
- `ENRAHITU_PUBLIC_URL` parses and its scheme is consistent with the
  cookie mode the entrypoint would select.
- The data directory exists and is writable by uid 1000, the check that
  turns the legacy root-owned-volume failure (spec 007) from a runtime
  crash into a stated precondition.
- The ledger URL parses and its scheme maps to a driver.
- The ports the entrypoint will bind are free: rauthy's 8081 and its
  hiqlite pair 8100/8200, the app's hiqlite pair 8300/8400, and the app's
  own listener, which is not a constant. The Encore runtime takes
  `ENCORE_LISTEN_ADDR`, then `PORT`, then 8080, so the packaged image
  binds 8080 and the dev topology (spec 033) binds 4000; the verb derives
  it rather than naming it (§3.7).
- Pending migrations exist or do not, reported rather than judged.

The entrypoint calls it and fails closed. Exit code is the verdict,
consistent with every other verb under spec 009 section 3.2.

### 3.6 The recovery objective, stated

The documentation states an RPO rather than implying one, because an
unstated RPO is always assumed to be zero:

- Cold backup: RPO is the interval between scheduled runs, and it is the
  only mode with no cross-store skew at all.
- Hot backup with both credentials: same interval, every store current as
  of its own capture, with the residual skew bounded by the duration of
  one run and always in §3.2's detectable direction.
- Hot backup missing the rauthy API key: identity is as of rauthy's last
  cron run, up to 24 hours by default. The verb reports this age, so an
  operator who has not configured a key is told what they actually have.
- Hot backup missing an operator session: the app's resource store falls
  back to the most recent snapshot the addon already wrote, and its age is
  reported the same way. It is never omitted and never silently stale.
- The app's hiqlite **cache group** (KV with TTLs, rate-limit counters,
  lock state): no objective. Derived by design, and the reason nothing
  durable may be written there.

### 3.7 Status (2026-08-04): `preflight` built, on the amended design

The amendment in §§3.1-3.3, §3.6 and §4 landed on its own, ahead of any verb,
and was worth separating because it changed what gets built rather than how.
It found two defects that the design as written would have shipped:

1. **The backup would have omitted the association's data and the restore
   would have deleted it** (§3.1, §3.3), because the premise that the app's
   hiqlite is derived cache state stopped being true three phases ago.
2. **`HQL_BACKUP_RESTORE` is one variable read by two hiqlite nodes**
   (§3.3). This one is live in the tree today rather than hypothetical: it
   is latent only because the app's store has held nothing worth restoring,
   which is the same premise defect wearing a different hat.

**`preflight` (§3.5) is the first verb built against that design**, with the
declared migration home §3.4 asks for (`backend/core/ledger/migration-list.ts`),
which the pre-flight reads and the `migrate` verb will execute. The entrypoint
calls it and fails closed, and its inline copy of spec 007's required-env check
is gone: a contract a fleet configures now has one implementation rather than
two, and the one it lost was the one nothing could test.

Building it corrected one of §3.5's own premises and turned an assumption into
a stated fork:

- **"The ports the entrypoint will bind are free: 8080, ..."** named a port the
  entrypoint does not always bind. The app's listener is
  `ENCORE_LISTEN_ADDR`, then `PORT`, then 8080, so the packaged image takes 8080
  and the dev topology takes 4000. A verb checking the constant would have
  passed over the port the dev container was about to bind and reported on one
  nothing wanted, which is a pre-flight that reads green for the wrong reason.
  §3.5 now says what the verb does. rauthy's three stay constants because they
  are constants: its HTTP port is set by the entrypoint and its hiqlite pair by
  `docker/rauthy/config.prod.toml`.
- **A node script cannot run CoreLedger's migration runner.** Pre-flight needs
  only the declared versions and gets them by loading the home under Node's own
  type stripping, which is why that file's module-level imports must stay
  type-only: an erased import costs nothing outside the app, and a value import
  to an extensionless specifier is unresolvable there. Applying a migration is a
  longer reach: `migrate()` and both drivers are TS whose value imports the
  bundler resolves and plain node does not. So CoreLedger's half of §3.4 lands
  either on the admin plane, as the state layer's half already did and as the
  2026-07-30 amendment's closing paragraph anticipates, or as a second runner in
  JS. That is decided when it is built, and it is now a fork with its constraint
  known rather than an assumption.

What remains, in the order the acceptance items want it: the CoreLedger half of
`migrate` (§3.4), the admin-plane backup endpoint the hot path needs (§3.2),
`backup` and `restore` themselves, the entrypoint's per-store restore scoping
(§3.3), and the four `[verbs]` entries with the contract bump to 0.8.0 (§4 item
1), which lands once all four exist rather than four times. Items 2, 3 and 5 need
a compose-level fixture rather than the app harness, because a cold backup
is defined by the container being stopped.

### 3.8 What the unamended spec would have shipped (2026-08-04)

This spec was written on 2026-07-25 and implemented on 2026-08-04, and in
the nine days between, the thing it was written about changed underneath
it. Recording that is the point of this section, because the spec read as
correct at every intermediate moment and the gap only becomes visible when
somebody tries to build it.

The superseded claim was that the app's hiqlite holds "the cache with TTLs
and rate-limit counters (spec 002), both derived and both correct to
lose", and the superseded consequence was that restore "recreates this
directory empty". Both were true when written. Spec 002's hiqlite was a
cache; the addon's whole surface was nine functions with no snapshot
primitive, which the spec enumerated to show the exclusion was forced
rather than chosen.

Then phase 2 took the addon from nine functions to twenty-one and added
`backup()`, phase 3 put the control plane's `resource` table behind it,
and phase 5 filled that table with the association. The spec's sentence
did not change and its meaning inverted: **"deliberately not backed up"
went from describing a cache to describing the primary store.**

What that would have shipped, had it been built as written: a `backup`
verb producing an archive with no members, tiers, memberships or dues in
it, and a `restore` verb whose documented behavior is to delete them. Both
would have passed their own acceptance tests, because those tests were
written from the same sentence. The archive would have restored, the
container would have started, and the damage would have surfaced later,
which is the failure mode §1 opens by warning about, reached by a route §1
did not anticipate: not a wrong mechanism, a stale premise.

The general form, and the reason this is a section rather than a footnote:
**a spec ahead of its code decays in a way a spec behind its code does
not.** Spec 001 §5.2's disposition table exists to catch exactly this and
carries the right instruction for a spec that lags ("rewrite pending, do
not rewrite ahead of the code"). It has no column for a spec that leads,
and 027 led by nine days across three phases. The cheap guard is the one
applied here: **re-read a pending spec's premises, not just its design,
at the moment somebody picks it up.** The design was fine. The facts under
it were not, and no gate can see that.

1. `template.toml` carries `preflight`, `migrate`, `backup`, and
   `restore` under `[verbs]`, `[contract].version` is `0.8.0`, and spec
   009's worked-minors list records the bump.
2. A cold backup of a populated cell, restored into a fresh volume,
   yields a container that starts, authenticates the pre-existing admin,
   serves the pre-existing CoreLedger rows, **serves the pre-existing
   members, tiers, memberships and dues invoices from the restored
   resource store**, and passes spec 024's chain verification on the
   restored `kernel_decisions` table.
3. A hot backup taken while traffic runs produces an archive whose
   CoreLedger member opens cleanly, whose resource member opens cleanly,
   and whose chain verifies. Restoring it yields the same outcomes as
   item 2.
4. A tampered archive (one byte changed in any member) is refused by
   `restore` before the volume is modified.
5. An archive whose keys are omitted fails to produce a working rauthy
   **and fails to open the restored resource store**, demonstrated once
   for each as a regression test for §3.1's binding, so the coupling is
   proven rather than asserted in both directions it now holds.
6. `restore` refuses a live container; `backup` without `--online`
   refuses a live container; `backup --online` without an API key
   reports the age of the identity snapshot it is shipping.
7. `migrate` applies a pending migration exactly once across two
   concurrent invocations, with the loser reporting a legible
   already-applied outcome rather than a constraint violation.
8. `preflight` fails with a named cause for each condition in section
   3.5, verified one at a time, and the entrypoint refuses to continue.
9. A restore offers each hiqlite node its own snapshot and never the
   other's: rauthy's node sees rauthy's file, the app's node sees the
   app's, and neither variable is visible in the other's environment.
   Asserted on the entrypoint's environment, because the failure this
   guards is inheritance rather than logic (§3.3).
10. A hot backup's manifest records a captured-at instant per member, and
    the resource store's instant precedes the chain's. The ordering is
    asserted rather than described, because it is the whole of §3.2's
    consistency answer and nothing else in the archive reveals it.
11. `npm run typecheck && npm test` green, coupling gate green.

## 5. Out of scope

- Backing up a remote CoreLedger (Turso, Postgres). Named, detected,
  and delegated to the provider.
- S3 or object-store backup targets. rauthy's own S3 support remains
  available to operators who configure it directly; this spec's verb
  writes a local artifact and leaves shipping it to the operator's
  existing backup infrastructure, which is the thing they already have.
- Encryption of the archive at rest. It is mode 0600 and documented as
  a secret; envelope encryption is a named extension.
- Point-in-time recovery and continuous WAL archiving. The substrate's
  target is scheduled snapshots; PITR is a Postgres-topology property
  and belongs with that driver.
- Backup of a multi-container topology's shared Postgres and nsqd
  (spec 030). That is standard infrastructure with standard tools, and
  this spec covers the cell.
- Down migrations. Spec 011 refused them and this spec does not reopen
  it.
- The operator documentation that every verb here implies: spec 028.

## Amendment (2026-07-30): the state layer's half of `migrate`

§3.4 was written when CoreLedger was the only durable store, and it describes the
verb against `backend/core/ledger/`. The pivot gave the state layer its own
schema and its own runner (spec 032 §3.6), and spec 034's control plane put the
`resource` table behind it. Nothing applied those migrations to a deployed
container, so phase 5's domain (spec 036) shipped on a schema no deployment had.

The state layer's half lands as an operator-gated pair on the admin data plane
(spec 023's amendment of the same date) rather than as a script under
`scripts/ops/`. The reason is the volume: at N=1 the app's embedded hiqlite node
holds it open, so a separate migrator process cannot reach the store while the
app is running. "One runner by construction" is satisfied by an operator invoking
it once, and the invocation is authenticated and recorded rather than anonymous.

This does not settle the rest of this spec. `preflight`, `backup`, and `restore`
remain pending and remain script-shaped, CoreLedger's half of `migrate` is
untouched, and `ENRAHITU_MIGRATE_ON_BOOT` still applies only to CoreLedger. When
this spec is implemented in full, the two halves want one verb over both stores,
and the admin pair becomes its transport for the state layer rather than a second
mechanism.

**Settled 2026-08-04.** The reasoning above generalized further than it claimed:
"at N=1 the app holds the volume open, so the operation must be performed by the
running app under an authenticated operator" is a property of the volume, not of
migration, so it governs the hot backup path identically (§3.2). The admin plane
is now the transport for both, and the pattern is stated once here rather than
re-derived per verb.
