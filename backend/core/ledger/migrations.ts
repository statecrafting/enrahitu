/**
 * Minimal forward-only migration runner (spec 011).
 *
 * Spec 003 scopes CoreLedger to `ensureSchema()` (idempotent create). A
 * control plane needs more: additive columns on live tables, applied in a
 * known order, exactly once. This is the smallest thing that safely delivers
 * that and nothing more.
 *
 * - Applied versions are recorded in `_coreledger_migrations`.
 * - Each pending migration runs inside one transaction together with its
 *   version-recording insert, so a failure rolls back both.
 * - Forward-only: a pending version at or below the highest already-applied
 *   version is refused (no backfilling history).
 * - Destructive changes stay out of scope: write them by hand, review them.
 *
 * The runner rides the `LedgerDriver` interface, so it works on both drivers;
 * the additive-column helper is dialect-aware.
 */

import type { LedgerDriver, LedgerTx, SqlStatement } from "./driver";
import type { ColumnType } from "./metadata";
import type { Dialect } from "./schema";
import { quoteIdent, sqlType } from "./schema";

export interface Migration {
  /** Strictly increasing; the ordering key and the recorded identity. */
  version: number;
  name: string;
  /** Applies the change; runs inside the recording transaction. */
  up: (tx: LedgerTx, dialect: Dialect) => Promise<void>;
}

const MIGRATIONS_TABLE = "_coreledger_migrations";

async function ensureMigrationsTable(driver: LedgerDriver): Promise<void> {
  const versionType = sqlType("integer", driver.dialect);
  const textType = sqlType("text", driver.dialect);
  await driver.execute(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(MIGRATIONS_TABLE)} (` +
      `${quoteIdent("version")} ${versionType} PRIMARY KEY, ` +
      `${quoteIdent("name")} ${textType} NOT NULL, ` +
      `${quoteIdent("applied_at")} ${textType} NOT NULL)`,
  );
}

/** Versions already recorded as applied, ascending. */
export async function appliedVersions(driver: LedgerDriver): Promise<number[]> {
  await ensureMigrationsTable(driver);
  const rows = await driver.query(
    `SELECT ${quoteIdent("version")} FROM ${quoteIdent(MIGRATIONS_TABLE)} ORDER BY ${quoteIdent("version")} ASC`,
  );
  return rows.map((row) => Number(row.version));
}

/**
 * Apply every pending migration in ascending version order. Idempotent:
 * already-applied versions are skipped. Returns the versions applied this run.
 */
export async function migrate(driver: LedgerDriver, migrations: Migration[]): Promise<number[]> {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (let k = 1; k < ordered.length; k++) {
    if (ordered[k].version === ordered[k - 1].version) {
      throw new Error(`CoreLedger: duplicate migration version ${ordered[k].version}`);
    }
  }

  const already = new Set(await appliedVersions(driver));
  const highestApplied = already.size > 0 ? Math.max(...already) : 0;
  const applied: number[] = [];

  for (const migration of ordered) {
    if (already.has(migration.version)) continue;
    if (migration.version <= highestApplied) {
      throw new Error(
        `CoreLedger: migration ${migration.version} ("${migration.name}") is out of order; ` +
          `version ${highestApplied} is already applied and migrations are forward-only`,
      );
    }
    await driver.transaction(async (tx) => {
      await migration.up(tx, driver.dialect);
      await tx.execute(
        `INSERT INTO ${quoteIdent(MIGRATIONS_TABLE)} (${quoteIdent("version")}, ${quoteIdent("name")}, ${quoteIdent("applied_at")}) VALUES (?, ?, ?)`,
        [migration.version, migration.name, new Date().toISOString()],
      );
    });
    applied.push(migration.version);
  }

  return applied;
}

/**
 * Additive-column DDL, dialect-aware. Postgres gets `IF NOT EXISTS`; SQLite
 * omits it (unsupported there), relying on the runner's once-only guarantee.
 * Destructive column changes are intentionally not offered here.
 */
export function addColumnSql(
  table: string,
  column: string,
  type: ColumnType,
  dialect: Dialect,
): SqlStatement {
  const ifNotExists = dialect === "postgres" ? "IF NOT EXISTS " : "";
  return {
    sql: `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${ifNotExists}${quoteIdent(column)} ${sqlType(type, dialect)}`,
    params: [],
  };
}
