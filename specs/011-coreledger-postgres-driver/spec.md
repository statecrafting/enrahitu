---
id: "011-coreledger-postgres-driver"
title: "CoreLedger Postgres driver: scaling as a driver swap, proven"
status: approved
created: "2026-07-14"
implementation: complete
depends_on:
  - "003-coreledger"
establishes:
  - "backend/core/ledger/postgres.ts"
  - "backend/core/ledger/migrations.ts"
  - "backend/core/ledger/postgres.test.ts"
summary: >
  The Postgres LedgerDriver that spec 003 stages as future work. The forcing
  function is the Stagecraft control plane: it is itself an EnRaHiTu app but
  carries webhook bursts, audit writes, and multi-tenant state, so it runs
  CoreLedger-on-Postgres while stamped customer apps run
  CoreLedger-on-libSQL/Turso. Same decorator surface, different driver; the
  "scaling is a driver swap, not a rewrite" thesis is validated by running
  the exact spec 003 test suite, unchanged, against both drivers. Selection
  is by URL scheme; the driver owns dialect DDL, `?`-to-`$n` placeholder
  translation, and a minimal forward-only migration runner.
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

- `backend/core/ledger/postgres.ts` (this spec): the `PostgresDriver`
  implementing the spec 003 `LedgerDriver` interface over a single
  `pg` connection pool, plus the exported `?`-to-`$n` placeholder
  translator it owns.
- `backend/core/ledger/migrations.ts` (this spec): the minimal
  forward-only migration runner and its additive-column helper.
- `backend/core/ledger/postgres.test.ts` (this spec): the Postgres-only
  proofs (concurrent smoke, migrations) plus the always-on unit tests for
  placeholder translation and dialect DDL that need no live database.

Amended in sibling territory (owning spec edited alongside):

- `backend/core/ledger/schema.ts`, `ledger.ts`, `index.ts`,
  `ledger.test.ts` (spec 003): `schema.ts` grows a dialect switch,
  `ledger.ts` grows URL-scheme driver selection, `index.ts` re-exports the
  new surface, and `ledger.test.ts` parameterizes its behavioral suite over
  both drivers. `backend/core/` as a directory stays owned by spec 003
  (relocated under `backend/` by spec 019); spec 003 §4 already invites this
  amendment ("a future spec amends this one when it lands").
- `.github/workflows/verify.yml` (spec 010): CI provisions a Postgres
  service so the parameterized suite exercises the Postgres arm on every
  run, not only where a developer happens to have a database.
- `package.json` / `package-lock.json` (spec 001 manifest): the `pg`
  client and its types are added; a mechanical dependency add, waived
  against 001 rather than amending the architecture spec.

## 3. Design constraints

- **Same `LedgerDriver` interface** (spec 003 `driver.ts`). Application
  code, repositories, and the codec in `repository.ts` change zero lines.
  The proof is literal: the spec 003 behavioral suite runs verbatim against
  the Postgres driver.
- **Codec-preserving storage types.** The spec 003 codec stringifies JSON
  and timestamps at the repository boundary and reads them back as strings,
  and one suite assertion reads a raw `created_at` value expecting the exact
  ISO string. So the Postgres column types are chosen to round-trip that
  codec unchanged, not to be maximally idiomatic:

  | ColumnType  | SQLite    | Postgres           | Note                                   |
  | ----------- | --------- | ------------------ | -------------------------------------- |
  | `text`      | TEXT      | TEXT               |                                        |
  | `integer`   | INTEGER   | BIGINT             | 64-bit; `pg` returns it as a string    |
  | `real`      | REAL      | DOUBLE PRECISION   |                                        |
  | `blob`      | BLOB      | BYTEA              | `Uint8Array` bound as a `Buffer`       |
  | `boolean`   | INTEGER   | BOOLEAN            | codec sends `1`/`0`; Postgres accepts  |
  | `json`      | TEXT      | TEXT               | codec `JSON.stringify`s; stays a string |
  | `timestamp` | TEXT      | TEXT               | ISO-8601 UTC string, exact round-trip  |

  `json`/`timestamp` deliberately stay TEXT: JSONB or TIMESTAMPTZ would
  make `pg` hand back a parsed object or `Date`, breaking the codec's
  `JSON.parse(String(v))` / raw-string expectations. Column-constraint
  syntax (`PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `DEFAULT`, quoted idents,
  `IF NOT EXISTS`) is identical across both dialects, so only the type map
  differs; decorator metadata stays dialect-free.
- **Placeholder binding.** Repositories emit libSQL-style positional `?`.
  The Postgres driver owns translation to `$1..$n`, scanning past
  single-quoted strings, double-quoted identifiers, and comments so a `?`
  inside a literal is never rewritten. The JSONB existence operators
  (`?`, `?|`, `?&`) cannot be expressed through the translated surface;
  a control-plane query that needs them uses the raw pool or
  `jsonb_exists()`.
- **Migrations beyond idempotent create.** Spec 003 scopes CoreLedger to
  `ensureSchema()` (idempotent create-if-absent). This spec owns the
  minimal migration story: a versioned, forward-only runner that records
  applied versions in `_coreledger_migrations`, applies each pending
  migration once inside a transaction, and refuses out-of-order (lower than
  already-applied) versions. Additive changes come with an `addColumn`
  helper (dialect-aware, `IF NOT EXISTS` on Postgres); destructive changes
  stay manual, hand-written, and reviewed.
- **FIPS-mode Postgres.** The target Hetzner Postgres rejects md5(); the
  driver SQL uses no md5 anywhere (it has no auth or checksum SQL to begin
  with). Do not reintroduce md5 in driver or migration SQL.
- **Connection pooling.** One `pg.Pool` per process, sized for the
  single-container deployment shape (`ENRAHITU_LEDGER_POOL_SIZE`, default
  10); no pgbouncer assumption.
- **Driver selection is config, not code.** URL scheme decides:
  `postgres://` / `postgresql://` selects the Postgres driver; `file:` /
  `libsql://` select libSQL (spec 003 behavior unchanged).

## 4. Acceptance

- The spec 003 behavioral suite passes against both drivers, from one
  parameterized `describe` per driver (`ledger.test.ts`): ensureSchema
  round-trips, codec fidelity, equality/null/order/limit finds,
  update/delete/count, UNIQUE enforcement, and transaction commit/rollback.
  The Postgres arm runs whenever `TEST_POSTGRES_URL` is set (CI service,
  or a local database) and skips cleanly otherwise, so a plain `npm test`
  stays green.
- A control-plane-shaped smoke (many concurrent writers plus concurrent
  reads through the pool, and a contended transactional increment) passes
  on Postgres.
- The migration runner applies pending migrations once, is idempotent on
  re-run, refuses out-of-order versions, and adds a column additively;
  proven on libSQL always and on Postgres when available.
- Turso-specific behavior (embedded replica sync) remains libSQL-only and
  untouched.

## 5. Out of scope

- Read replicas, sharding, or any beyond-one-Postgres scaling.
- Porting rauthy or hiqlite off their own storage (they are not CoreLedger
  consumers).
- A general-purpose ORM; CoreLedger stays the minimal decorator surface
  spec 003 defines.
- Rich migration tooling (rollbacks, squashing, generation); the runner is
  deliberately the minimum a control plane needs to add columns safely.

## 6. Status

- 2026-07-14: complete. `PostgresDriver`, the `schema.ts` dialect switch,
  `?`-to-`$n` translation, and the migration runner landed behind the
  unchanged decorator surface. Acceptance verified against a live Postgres
  (postgres:17-alpine): the spec 003 behavioral suite passed identically on
  both driver arms (16 tests), the concurrent smoke passed (200 concurrent
  inserts interleaved with reads, plus 50 contended transactional counter
  increments landing exactly), and the migration runner passed on both
  libSQL and Postgres (apply-once, idempotent re-run, out-of-order and
  duplicate-version refusal). A plain `npm test` with no database stays
  green (the Postgres arm skips); CI now provisions a digest-pinned Postgres
  service (spec 010) so both arms run on every push. `libsql.ts` and Turso
  embedded-replica sync were not touched.
