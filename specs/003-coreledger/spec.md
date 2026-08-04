---
id: "003-coreledger"
title: "CoreLedger: decorator data layer on libSQL/Turso"
status: approved
created: "2026-07-14"
implementation: complete
origin:
  retroactive: true   # phase 1 shipped before the spec graph existed
depends_on:
  - "001-enrahitu-architecture"
establishes:
  - { kind: directory, path: "backend/core/" }
summary: >
  The durable data layer: stage-3 @Entity/@Column decorators over a
  LedgerDriver interface, with a libSQL driver speaking a local SQLite file
  by default and Turso embedded-replica sync (syncUrl + authToken) when
  configured. ensureSchema() creates tables from decorator metadata; typed
  repositories give find/save ergonomics. Replaces Encore SQLDatabase so no
  managed database is required to develop, build, or ship.
---

# 003: CoreLedger

## 1. Purpose

Durable relational data with zero managed infrastructure: a local SQLite
file by default, managed offsite durability (Turso embedded replica) as a
config change, and a future Postgres driver behind the same decorator
surface when scale demands it. Scaling is a driver swap, not a rewrite.

## 2. Territory

`backend/core/ledger/`: `decorators.ts` (`@Entity`, `@Column`, `ColumnOptions`),
`metadata.ts` (module-level registries), `driver.ts` (the `LedgerDriver`
interface), `libsql.ts` (`LibsqlDriver`, local file + Turso replica),
`schema.ts` (`createTableSql`, `ensureSchema`), `repository.ts`
(`Repository`, `FindOptions`), `ledger.ts` (the `Ledger` facade and the
module singleton), and the barrel `index.ts`.

## 3. Behavior

- **Decorators are the CoreLedger API from day one.** Stage-3 TS decorators
  (no `experimentalDecorators`, no `emitDecoratorMetadata`); metadata lives
  in module-level registries, not `Symbol.metadata` (Node support not
  assumed).
- The default ledger URL is a `file:` path (in the container:
  `file:/data/ledger/enrahitu.db`, spec 007); `ENRAHITU_LEDGER_URL` overrides.
  Turso sync activates when `syncUrl` + `authToken` are configured.
- `ensureSchema()` is idempotent and derives DDL from decorator metadata.
- Consumers: the auth service persists users, refresh tokens, and audit
  records on CoreLedger (spec 004); the health service exercises a
  decorator canary (spec 001).

## 4. Out of scope

- The Postgres driver landed in spec 011: `schema.ts` grew a dialect switch
  and `ledger.ts` grew URL-scheme driver selection, both behind this same
  decorator surface. The libSQL default and codec are unchanged.
- Migrations beyond idempotent `ensureSchema()` table creation: the minimal
  forward-only migration runner is owned by spec 011.
- Query-builder or relation features beyond the typed repository surface.

## 5. Phase A seam (amended by spec 021, 2026-07-20)

Driver selection moves to its own module (`from-env.ts`, exporting
`rawDriverFromEnv()`), and the `Ledger` facade wraps the selected driver
in spec 021's governed proxy before use: `query`/`execute`/`batch`/
`transaction` adjudicate as `db.read`/`db.write`/`db.migrate`/`db.txn`
on resource `app`, and interactive transactions re-wrap the inner tx so
nothing escapes the seam. The raw driver remains constructible only for
the enforcement plane itself (the spec 021 Decision store) and for
driver unit tests; the extraction ban-list enforces that boundary. The
decorator surface and both drivers are otherwise unchanged.

Amended by spec 022 (2026-07-22): the facade's `driverFromEnv()` wraps
the governed driver in the observability instrumentation outermost
(`instrumentDriver(governDriver(raw, "app"), "app")`), so operation
counters and spans cover adjudication plus the operation and a kernel
deny surfaces as an errored child span. The Decision store keeps the
raw, uninstrumented driver: the enforcement plane's audit trail is not
traffic.

## Amendment (2026-08-04): the migration list gains a home (spec 027)

`backend/core/ledger/migration-list.ts` exports `CORE_LEDGER_MIGRATIONS`, the
list spec 011's runner runs and spec 027 §3.4's `migrate` verb applies. §4 keeps
migrations beyond `ensureSchema()` out of this spec's design and that is
unchanged: what lands here is the declared location, exported from the barrel
beside `migrate` itself, because a runner whose input has no home is a mechanism
with nothing to run. The list is empty today.

Its module-level imports stay type-only, and that constraint is load bearing
rather than stylistic. `scripts/ops/preflight.mjs` reports the pending count
before the app is a process, so it loads this file under Node's own type
stripping, where an `import type` is erased and a value import to an
extensionless specifier does not resolve. The constraint binds this file alone:
an `up()` body runs inside the app and receives the dialect precisely so a
migration can branch on it without reaching for a helper.

This is chassis schema, not application schema. An extension registers a kind
through the control plane and needs no migration at all (spec 034), which is why
the home sits under `backend/`, where an upgrade replaces it wholesale, rather
than under `app/`, where an upgrade never touches it (spec 035).
