/**
 * DDL generation from decorator metadata.
 *
 * `ensureSchema` is idempotent CREATE-IF-NOT-EXISTS, which covers greenfield
 * boot and additive tables. Column evolution (ALTER) is the migration
 * runner's job (spec 011, migrations.ts). Type names are the only thing that
 * differs between dialects: column-constraint syntax (PRIMARY KEY, NOT NULL,
 * UNIQUE, DEFAULT, quoted identifiers, IF NOT EXISTS) is identical across
 * SQLite and Postgres, so the whole DDL is one code path gated on a type map.
 *
 * The Postgres type map is chosen to round-trip the spec 003 codec
 * (repository.ts) unchanged: `json`/`timestamp` stay TEXT so `pg` hands back
 * a string, not a parsed object or Date (see spec 011 §3).
 */

import type { ColumnType, EntityCtor, EntityMeta } from "./metadata";
import { allEntities, entityMeta } from "./metadata";
import type { LedgerDriver, SqlStatement } from "./driver";

export type Dialect = "sqlite" | "postgres";

const SQLITE_TYPES: Record<ColumnType, string> = {
  text: "TEXT",
  integer: "INTEGER",
  real: "REAL",
  blob: "BLOB",
  boolean: "INTEGER", // 0/1
  json: "TEXT", // JSON.stringify at the repository boundary
  timestamp: "TEXT", // ISO-8601 UTC
};

const POSTGRES_TYPES: Record<ColumnType, string> = {
  text: "TEXT",
  integer: "BIGINT", // 64-bit; pg returns it as a string, Number()-coerced by the codec
  real: "DOUBLE PRECISION",
  blob: "BYTEA",
  boolean: "BOOLEAN", // codec sends 1/0; Postgres accepts them and returns a JS boolean
  json: "TEXT", // codec JSON.stringify's; stays a string so JSON.parse(String(v)) round-trips
  timestamp: "TEXT", // ISO-8601 UTC string; exact round-trip (TIMESTAMPTZ would parse to a Date)
};

const TYPE_MAPS: Record<Dialect, Record<ColumnType, string>> = {
  sqlite: SQLITE_TYPES,
  postgres: POSTGRES_TYPES,
};

/** SQL storage type for a CoreLedger column type in the given dialect. */
export function sqlType(type: ColumnType, dialect: Dialect): string {
  return TYPE_MAPS[dialect][type];
}

export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`CoreLedger: unsafe SQL identifier "${name}"`);
  }
  return `"${name}"`;
}

export function createTableSql(meta: EntityMeta, dialect: Dialect = "sqlite"): SqlStatement[] {
  const columnDefs = meta.columns.map((col) => {
    const parts = [quoteIdent(col.name), sqlType(col.type, dialect)];
    if (col.primary) parts.push("PRIMARY KEY");
    else if (!col.nullable) parts.push("NOT NULL");
    if (col.unique && !col.primary) parts.push("UNIQUE");
    if (col.defaultSql !== undefined) parts.push(`DEFAULT ${col.defaultSql}`);
    return parts.join(" ");
  });

  const statements: SqlStatement[] = [
    {
      sql: `CREATE TABLE IF NOT EXISTS ${quoteIdent(meta.table)} (${columnDefs.join(", ")})`,
      params: [],
    },
  ];

  for (const col of meta.columns) {
    if (col.indexed && !col.primary && !col.unique) {
      const indexName = quoteIdent(`idx_${meta.table}_${col.name}`);
      statements.push({
        sql: `CREATE INDEX IF NOT EXISTS ${indexName} ON ${quoteIdent(meta.table)} (${quoteIdent(col.name)})`,
        params: [],
      });
    }
  }

  return statements;
}

/**
 * Create tables + indexes for the given entities (default: every registered
 * entity), in the driver's dialect. Safe to call on every boot.
 */
export async function ensureSchema(
  driver: LedgerDriver,
  entities?: EntityCtor[],
): Promise<void> {
  const metas = entities ? entities.map((e) => entityMeta(e)) : allEntities();
  const statements = metas.flatMap((meta) => createTableSql(meta, driver.dialect));
  if (statements.length > 0) {
    await driver.batch(statements);
  }
}
