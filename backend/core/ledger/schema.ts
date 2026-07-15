/**
 * DDL generation from decorator metadata.
 *
 * v0 policy (docs/ARCHITECTURE.md): `ensureSchema` is idempotent
 * CREATE-IF-NOT-EXISTS, which covers greenfield boot and additive tables.
 * Column evolution (ALTER) is a follow-up spec; the SQL dialect here is
 * SQLite only, gated on the driver's `dialect`.
 */

import type { ColumnType, EntityCtor, EntityMeta } from "./metadata";
import { allEntities, entityMeta } from "./metadata";
import type { LedgerDriver, SqlStatement } from "./driver";

const SQLITE_TYPES: Record<ColumnType, string> = {
  text: "TEXT",
  integer: "INTEGER",
  real: "REAL",
  blob: "BLOB",
  boolean: "INTEGER", // 0/1
  json: "TEXT", // JSON.stringify at the repository boundary
  timestamp: "TEXT", // ISO-8601 UTC
};

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`CoreLedger: unsafe SQL identifier "${name}"`);
  }
  return `"${name}"`;
}

export function createTableSql(meta: EntityMeta): SqlStatement[] {
  const columnDefs = meta.columns.map((col) => {
    const parts = [quoteIdent(col.name), SQLITE_TYPES[col.type]];
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
 * entity). Safe to call on every boot.
 */
export async function ensureSchema(
  driver: LedgerDriver,
  entities?: EntityCtor[],
): Promise<void> {
  if (driver.dialect !== "sqlite") {
    throw new Error(
      `CoreLedger: ensureSchema has no ${driver.dialect} DDL emitter yet (v0 is SQLite-only)`,
    );
  }
  const metas = entities ? entities.map((e) => entityMeta(e)) : allEntities();
  const statements = metas.flatMap((meta) => createTableSql(meta));
  if (statements.length > 0) {
    await driver.batch(statements);
  }
}
