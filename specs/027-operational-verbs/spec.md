---
id: "027-operational-verbs"
title: "Operational verbs: preflight, migrate, backup, restore"
status: approved
created: "2026-07-25"
implementation: pending
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
  (contract v0.7.0) and their implementations. The backup design is
  shaped by what each of the four state classes on the volume actually
  is: CoreLedger snapshots online through VACUUM INTO, rauthy's identity
  store is captured through rauthy's own integrity-checked backup
  mechanism rather than by copying raft directories, the app's hiqlite is
  deliberately excluded as derived state, and key material is bound into
  the same archive because a rauthy backup without its matching ENC_KEYS
  is unrecoverable.
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

**The app's hiqlite is deliberately not backed up.** Its entire contents
are the cache with TTLs and rate-limit counters (spec 002), both derived
and both correct to lose: a restored cell rebuilds the cache on demand
and starts every rate-limit window fresh. This is also the only
available answer, because the addon exposes no snapshot primitive. Its
API surface is `counterAdd`, `counterDel`, `counterGet`, `counterSet`,
`health`, `init`, `kvDel`, `kvGet`, and `kvPut`, and nothing else.
Restore therefore recreates this directory empty rather than
reconstituting it, and that is a stated property, not an omission.

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
rest with `ENC_KEYS` from `/data/rauthy/secrets.env`. A rauthy backup
restored without its matching keys is undecryptable. Keys and the
identity store are therefore never separable: they go into one archive
or the archive is worthless. This single fact is why the verb produces
one artifact rather than letting an operator assemble parts.

Because the archive contains every secret the cell holds, it is a
secret in its entirety. The verb says so, sets mode 0600, and refuses
to write to a world-readable destination.

### 3.2 `backup`

Two modes, because the honest default and the zero-downtime path are
different tools.

**Cold (default).** The container is stopped. Every class is at rest, so
the verb copies the CoreLedger file, the rauthy data directory, and the
key material, writes a manifest, and checksums the result. No API, no
credentials, no coordination. This is always correct and is what the
documentation recommends for scheduled backups of a single cell.

**Hot (`--online`).** The container is running. CoreLedger is captured
with `VACUUM INTO`. rauthy is asked for a fresh backup over
`POST /auth/v1/backup` and the named file is collected from
`/data/rauthy/db`, so the identity snapshot is current as of the verb's
invocation rather than as of rauthy's overnight cron. This path needs a
rauthy admin API key, supplied as `ENRAHITU_RAUTHY_API_KEY`; without
it, the verb reports that it can only reach the most recent cron-made
backup and names its age rather than silently shipping a stale one.

Both modes emit one `.tar.gz` containing a `manifest.json` that records:
the template and contract versions, the app model hash and gate config
hash from the kernel boot receipt (spec 021), the ledger URL scheme, the
mode used, a per-member SHA-256, and the timestamp. The manifest is what
makes the archive verifiable rather than merely present.

### 3.3 `restore`

Refuses to run against a live container. Verifies every checksum in the
manifest before touching the volume, and refuses on any mismatch.

CoreLedger is placed as the database file. Key material is written back
at 0600. rauthy is restored through its own documented path rather than
by file placement: `HQL_BACKUP_RESTORE=file:<path>` on the next start,
which rauthy validates against the `_metadata` table, followed by
removal of that variable. The entrypoint learns to pass the variable
through for exactly one boot and to clear it afterwards, so an operator
cannot leave a restore loop armed.

`/data/hiqlite` is recreated empty, per section 3.1.

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
- The ports the entrypoint will bind are free: 8080, 8081, and the
  hiqlite pairs 8100/8200 and 8300/8400.
- Pending migrations exist or do not, reported rather than judged.

The entrypoint calls it and fails closed. Exit code is the verdict,
consistent with every other verb under spec 009 section 3.2.

### 3.6 The recovery objective, stated

The documentation states an RPO rather than implying one, because an
unstated RPO is always assumed to be zero:

- Cold backup: RPO is the interval between scheduled runs.
- Hot backup with an API key: same, and the identity store is current as
  of each run.
- Hot backup without an API key: identity is as of rauthy's last cron
  run, up to 24 hours by default. The verb reports this age, so an
  operator who has not configured a key is told what they actually have.
- The app's hiqlite: no objective. Derived state, by design.

## 4. Acceptance

1. `template.toml` carries `preflight`, `migrate`, `backup`, and
   `restore` under `[verbs]`, `[contract].version` is `0.7.0`, and spec
   009's worked-minors list records the bump.
2. A cold backup of a populated cell, restored into a fresh volume,
   yields a container that starts, authenticates the pre-existing admin,
   serves the pre-existing CoreLedger rows, and passes spec 024's chain
   verification on the restored `kernel_decisions` table.
3. A hot backup taken while traffic runs produces an archive whose
   CoreLedger member opens cleanly and whose chain verifies. Restoring
   it yields the same outcomes as item 2.
4. A tampered archive (one byte changed in any member) is refused by
   `restore` before the volume is modified.
5. An archive whose keys are omitted fails to produce a working rauthy,
   demonstrated once as a regression test for the section 3.1 binding,
   so the coupling is proven rather than asserted.
6. `restore` refuses a live container; `backup` without `--online`
   refuses a live container; `backup --online` without an API key
   reports the age of the identity snapshot it is shipping.
7. `migrate` applies a pending migration exactly once across two
   concurrent invocations, with the loser reporting a legible
   already-applied outcome rather than a constraint violation.
8. `preflight` fails with a named cause for each condition in section
   3.5, verified one at a time, and the entrypoint refuses to continue.
9. `npm run typecheck && npm test` green, coupling gate green.

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
