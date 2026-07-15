import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  Column,
  Entity,
  Ledger,
  LibsqlDriver,
  PostgresDriver,
  addColumnSql,
  appliedVersions,
  createTableSql,
  entityMeta,
  migrate,
  sqlType,
  translatePlaceholders,
  type LedgerDriver,
  type Migration,
} from "./index";

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

// ---------------------------------------------------------------------------
// Always-on unit tests: no database required.
// ---------------------------------------------------------------------------

describe("translatePlaceholders", () => {
  it("rewrites positional ? to $1..$n in order", () => {
    expect(translatePlaceholders(`SELECT * FROM "t" WHERE a = ? AND b = ?`)).toBe(
      `SELECT * FROM "t" WHERE a = $1 AND b = $2`,
    );
  });

  it("leaves SQL without placeholders untouched", () => {
    expect(translatePlaceholders(`SELECT 1`)).toBe(`SELECT 1`);
  });

  it("does not rewrite a ? inside a single-quoted string literal", () => {
    expect(translatePlaceholders(`WHERE note = 'why?' AND id = ?`)).toBe(
      `WHERE note = 'why?' AND id = $1`,
    );
  });

  it("handles escaped quotes inside a string literal", () => {
    expect(translatePlaceholders(`WHERE q = 'it''s a ?' AND id = ?`)).toBe(
      `WHERE q = 'it''s a ?' AND id = $1`,
    );
  });

  it("does not rewrite a ? inside a double-quoted identifier", () => {
    expect(translatePlaceholders(`SELECT "od?d" FROM t WHERE id = ?`)).toBe(
      `SELECT "od?d" FROM t WHERE id = $1`,
    );
  });

  it("does not rewrite ? inside line or block comments", () => {
    expect(translatePlaceholders(`SELECT 1 -- a ? here\nWHERE id = ?`)).toBe(
      `SELECT 1 -- a ? here\nWHERE id = $1`,
    );
    expect(translatePlaceholders(`SELECT 1 /* a ? here */ WHERE id = ?`)).toBe(
      `SELECT 1 /* a ? here */ WHERE id = $1`,
    );
  });

  it("leaves the JSONB ?|, ?&, ?? operators alone", () => {
    expect(translatePlaceholders(`data ?| array['a'] AND id = ?`)).toBe(
      `data ?| array['a'] AND id = $1`,
    );
    expect(translatePlaceholders(`data ?& array['a'] AND id = ?`)).toBe(
      `data ?& array['a'] AND id = $1`,
    );
  });
});

@Entity("pg_types")
class PgTypesEntity {
  @Column({ primary: true }) id = "";
  @Column({ type: "integer" }) n = 0;
  @Column({ type: "real" }) r = 0;
  @Column({ type: "blob" }) b = new Uint8Array();
  @Column({ type: "boolean" }) flag = false;
  @Column({ type: "json" }) data: unknown = null;
  @Column({ type: "timestamp" }) at = new Date("2026-01-01T00:00:00.000Z");
  @Column({ index: true }) label = "";
}

describe("dialect DDL", () => {
  it("maps CoreLedger types to Postgres storage types", () => {
    expect(sqlType("integer", "postgres")).toBe("BIGINT");
    expect(sqlType("real", "postgres")).toBe("DOUBLE PRECISION");
    expect(sqlType("blob", "postgres")).toBe("BYTEA");
    expect(sqlType("boolean", "postgres")).toBe("BOOLEAN");
    expect(sqlType("json", "postgres")).toBe("TEXT");
    expect(sqlType("timestamp", "postgres")).toBe("TEXT");
  });

  it("emits Postgres column types in CREATE TABLE, distinct from SQLite", () => {
    const meta = entityMeta(PgTypesEntity);
    const pg = createTableSql(meta, "postgres")[0].sql;
    expect(pg).toContain(`"n" BIGINT`);
    expect(pg).toContain(`"r" DOUBLE PRECISION`);
    expect(pg).toContain(`"b" BYTEA`);
    expect(pg).toContain(`"flag" BOOLEAN`);
    expect(pg).toContain(`"data" TEXT`);
    expect(pg).toContain(`"at" TEXT`);

    const sqlite = createTableSql(meta, "sqlite")[0].sql;
    expect(sqlite).toContain(`"n" INTEGER`);
    expect(sqlite).toContain(`"b" BLOB`);
    expect(sqlite).toContain(`"flag" INTEGER`);
  });

  it("emits an index create as a separate statement", () => {
    const statements = createTableSql(entityMeta(PgTypesEntity), "postgres");
    expect(statements).toHaveLength(2);
    expect(statements[1].sql).toContain(`CREATE INDEX IF NOT EXISTS "idx_pg_types_label"`);
  });

  it("adds an additive column with IF NOT EXISTS only on Postgres", () => {
    expect(addColumnSql("widgets", "color", "text", "postgres").sql).toBe(
      `ALTER TABLE "widgets" ADD COLUMN IF NOT EXISTS "color" TEXT`,
    );
    expect(addColumnSql("widgets", "color", "text", "sqlite").sql).toBe(
      `ALTER TABLE "widgets" ADD COLUMN "color" TEXT`,
    );
  });
});

// ---------------------------------------------------------------------------
// Migration runner: dialect-agnostic. Proven on libSQL always, Postgres too
// when TEST_POSTGRES_URL is set.
// ---------------------------------------------------------------------------

async function migrationChecks(driver: LedgerDriver): Promise<void> {
  await driver.execute(`DROP TABLE IF EXISTS "widgets"`);
  await driver.execute(`DROP TABLE IF EXISTS "_coreledger_migrations"`);
  await driver.execute(`CREATE TABLE IF NOT EXISTS "widgets" ("id" TEXT PRIMARY KEY)`);

  const migrations: Migration[] = [
    {
      version: 1,
      name: "add widgets.color",
      up: async (tx, dialect) => {
        const stmt = addColumnSql("widgets", "color", "text", dialect);
        await tx.execute(stmt.sql, stmt.params);
      },
    },
  ];

  expect(await migrate(driver, migrations)).toEqual([1]);

  // The new column exists and is writable.
  await driver.execute(`INSERT INTO "widgets" ("id", "color") VALUES (?, ?)`, ["w1", "red"]);
  const rows = await driver.query(`SELECT "color" FROM "widgets" WHERE "id" = ?`, ["w1"]);
  expect(rows[0].color).toBe("red");

  // Idempotent on re-run.
  expect(await migrate(driver, migrations)).toEqual([]);
  expect(await appliedVersions(driver)).toEqual([1]);

  // Forward-only: a pending version at/below the highest applied is refused.
  await expect(
    migrate(driver, [
      ...migrations,
      { version: 0, name: "backfill", up: async () => {} },
    ]),
  ).rejects.toThrow(/out of order/);

  // Duplicate versions are rejected outright.
  await expect(
    migrate(driver, [
      { version: 2, name: "a", up: async () => {} },
      { version: 2, name: "b", up: async () => {} },
    ]),
  ).rejects.toThrow(/duplicate migration version 2/);

  await driver.execute(`DROP TABLE IF EXISTS "widgets"`);
  await driver.execute(`DROP TABLE IF EXISTS "_coreledger_migrations"`);
}

describe("migration runner (libsql)", () => {
  let dir: string;
  let driver: LibsqlDriver;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "enrahitu-migrate-"));
    driver = new LibsqlDriver({ url: `file:${join(dir, "m.db")}` });
  });

  afterAll(async () => {
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies once, is idempotent, refuses out-of-order and duplicate versions", async () => {
    await migrationChecks(driver);
  });
});

// ---------------------------------------------------------------------------
// Postgres-only: the migration runner on Postgres, plus a control-plane-shaped
// concurrency smoke. Skips cleanly when no database is configured.
// ---------------------------------------------------------------------------

@Entity("smoke_events")
class SmokeEvent {
  @Column({ primary: true }) id = "";
  @Column({ index: true }) topic = "";
  @Column({ type: "integer" }) seq = 0;
  @Column({ type: "timestamp" }) at = new Date("2026-01-01T00:00:00.000Z");
}

@Entity("counters")
class Counter {
  @Column({ primary: true }) id = "";
  @Column({ type: "integer" }) n = 0;
}

const describePg = POSTGRES_URL ? describe : describe.skip;

describePg("PostgresDriver against a live database", () => {
  let ledger: Ledger;

  beforeAll(async () => {
    ledger = new Ledger(new PostgresDriver({ url: POSTGRES_URL as string, poolSize: 12 }));
    await ledger.execute(`DROP TABLE IF EXISTS "smoke_events"`);
    await ledger.execute(`DROP TABLE IF EXISTS "counters"`);
    await ledger.init([SmokeEvent, Counter]);
  });

  afterAll(async () => {
    await ledger.execute(`DROP TABLE IF EXISTS "smoke_events"`);
    await ledger.execute(`DROP TABLE IF EXISTS "counters"`);
    await ledger.close();
  });

  it("runs the migration runner on Postgres", async () => {
    await migrationChecks(ledger.driver);
  });

  it("absorbs many concurrent writers interleaved with reads", async () => {
    const total = 200;
    const inserts = Array.from({ length: total }, (_, i) =>
      ledger.repo(SmokeEvent).insert(
        Object.assign(new SmokeEvent(), { id: `e${i}`, topic: `t${i % 4}`, seq: i }),
      ),
    );
    // Interleave reads while writes are in flight.
    const reads = Array.from({ length: 10 }, () => ledger.repo(SmokeEvent).count());
    await Promise.all([...inserts, ...reads]);

    expect(await ledger.repo(SmokeEvent).count()).toBe(total);
    expect(await ledger.repo(SmokeEvent).count({ topic: "t0" })).toBe(total / 4);
  });

  it("keeps a contended transactional counter consistent", async () => {
    await ledger.repo(Counter).insert(Object.assign(new Counter(), { id: "c", n: 0 }));
    const bumps = 50;
    await Promise.all(
      Array.from({ length: bumps }, () =>
        ledger.transaction(async ({ tx }) => {
          await tx.execute(`UPDATE "counters" SET "n" = "n" + 1 WHERE "id" = ?`, ["c"]);
        }),
      ),
    );
    const found = await ledger.repo(Counter).findById("c");
    expect(found?.n).toBe(bumps);
  });
});
