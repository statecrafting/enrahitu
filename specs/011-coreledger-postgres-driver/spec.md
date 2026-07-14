---
id: "011-coreledger-postgres-driver"
title: "CoreLedger Postgres driver: scaling as a driver swap, proven"
status: draft
created: "2026-07-14"
depends_on:
  - "003-coreledger"
establishes:
  - "core/ledger/postgres.ts"
summary: >
  Design for the Postgres LedgerDriver that spec 003 stages as future work.
  The forcing function is the Stagecraft control plane: it is itself an
  EnRaHiTu app but carries webhook bursts, audit writes, and multi-tenant
  state, so it runs CoreLedger-on-Postgres while stamped customer apps run
  CoreLedger-on-libSQL/Turso. Same decorator surface, different driver;
  the "scaling is a driver swap, not a rewrite" thesis gets validated in
  production on ourselves before any customer needs it. Draft: territory
  claims land with the code.
---

# 011: CoreLedger Postgres driver

## 1. Purpose

Spec 003 §1 promises "a future Postgres driver behind the same decorator
surface when scale demands it." Scale now demands it, from an unexpected
direction: not a stamped app outgrowing SQLite, but the Stagecraft control
plane (the platform that stamps the apps) choosing Postgres from day one.
The control plane is the app most likely to hit SQLite-family limits first
(webhook bursts, audit write volume, multi-tenant contention), and it
already lives next to managed Postgres on the existing K8s cluster.

Building the driver instead of porting the control plane to libSQL keeps
the decorator surface as the single data API and makes the driver swap
real on day one: control plane on Postgres, stamped apps on libSQL/Turso,
identical application code above the driver line.

## 2. Territory

`core/ledger/postgres.ts` (the `PostgresDriver`), claimed ahead of the
code so the path is reserved: creating the driver without touching this
spec trips the coupling gate. The driver selection logic in
`core/ledger/ledger.ts` gets amended when the code lands; `core/` as a
directory stays owned by spec 003.

## 3. Design constraints

- **Same `LedgerDriver` interface** (spec 003 `driver.ts`). Application
  code, repositories, and decorators change zero lines.
- **Dialect-aware DDL.** `createTableSql` / `ensureSchema` (spec 003
  `schema.ts`) currently emit SQLite-flavored DDL. Schema generation grows
  a dialect switch (types, autoincrement, upsert forms); decorator
  metadata stays dialect-free.
- **Parameter binding.** libSQL positional `?` vs Postgres `$1`; the
  driver owns placeholder translation so repositories stay portable.
- **Migrations beyond idempotent create.** Spec 003 scopes CoreLedger to
  `ensureSchema()` (idempotent create-if-absent). A control plane needs
  additive migrations at minimum (new columns on live tables). This spec
  owns the minimal migration story: versioned, forward-only, additive
  first; destructive changes stay manual and reviewed.
- **FIPS-mode Postgres.** The target Hetzner Postgres rejects md5();
  any auth or checksum SQL uses sha256. (Operational lesson from the
  platform history; do not reintroduce md5 anywhere in driver SQL.)
- **Connection pooling.** One pool per process, sized for the
  single-container deployment shape; no pgbouncer assumption.
- **Driver selection is config, not code.** URL scheme decides:
  `postgres://` selects the Postgres driver; `file:` / `libsql://` select
  libSQL (spec 003 behavior unchanged).

## 4. Acceptance

- The spec 003 test suite passes against both drivers (same tests,
  parameterized by driver), including ensureSchema round-trips and
  repository find/save semantics.
- A control-plane-shaped smoke (concurrent writers + reads) passes on
  Postgres.
- Turso-specific behavior (embedded replica sync) remains libSQL-only and
  untouched.

## 5. Out of scope

- Read replicas, sharding, or any beyond-one-Postgres scaling.
- Porting rauthy or hiqlite off their own storage (they are not CoreLedger
  consumers).
- A general-purpose ORM; CoreLedger stays the minimal decorator surface
  spec 003 defines.
