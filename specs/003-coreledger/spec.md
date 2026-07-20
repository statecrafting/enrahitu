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
