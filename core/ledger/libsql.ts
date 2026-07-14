/**
 * libSQL driver: one driver, two deployment shapes.
 *
 * - `url: "file:..."` alone: plain local SQLite file (the default; costs
 *   nothing but disk).
 * - `url: "file:..."` + `syncUrl: "libsql://<db>.turso.io"` + `authToken`:
 *   Turso embedded replica; reads stay local, writes sync to the managed
 *   primary.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createClient } from "@libsql/client";
import type { Client, InStatement, ResultSet, Transaction } from "@libsql/client";

import type {
  ExecuteResult,
  LedgerDriver,
  LedgerTx,
  SqlRow,
  SqlStatement,
  SqlValue,
} from "./driver";

export interface LibsqlConfig {
  /** `file:` path or remote `libsql://` URL. */
  url: string;
  /** Turso sync target; makes a `file:` url an embedded replica. */
  syncUrl?: string;
  authToken?: string;
  /** Background sync cadence for embedded replicas, in seconds. */
  syncIntervalSecs?: number;
}

function rowsOf(rs: ResultSet): SqlRow[] {
  return rs.rows.map((row) => {
    const record: SqlRow = {};
    for (const column of rs.columns) {
      const value = row[column];
      record[column] =
        value instanceof ArrayBuffer ? new Uint8Array(value) : (value as SqlValue);
    }
    return record;
  });
}

function inStatement(sql: string, params: SqlValue[]): InStatement {
  return { sql, args: params };
}

export class LibsqlDriver implements LedgerDriver {
  readonly dialect = "sqlite" as const;
  private readonly client: Client;

  constructor(config: LibsqlConfig) {
    if (config.url.startsWith("file:")) {
      // libsql does not create parent directories for local files.
      const path = config.url.slice("file:".length);
      if (path !== ":memory:") {
        mkdirSync(dirname(path), { recursive: true });
      }
    }
    this.client = createClient({
      url: config.url,
      syncUrl: config.syncUrl,
      authToken: config.authToken,
      syncInterval: config.syncIntervalSecs,
    });
  }

  async query(sql: string, params: SqlValue[] = []): Promise<SqlRow[]> {
    return rowsOf(await this.client.execute(inStatement(sql, params)));
  }

  async execute(sql: string, params: SqlValue[] = []): Promise<ExecuteResult> {
    const rs = await this.client.execute(inStatement(sql, params));
    return { rowsAffected: rs.rowsAffected };
  }

  async batch(statements: SqlStatement[]): Promise<void> {
    await this.client.batch(
      statements.map((s) => inStatement(s.sql, s.params)),
      "write",
    );
  }

  async transaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
    const tx: Transaction = await this.client.transaction("write");
    try {
      const result = await fn({
        query: async (sql, params = []) => rowsOf(await tx.execute(inStatement(sql, params))),
        execute: async (sql, params = []) => {
          const rs = await tx.execute(inStatement(sql, params));
          return { rowsAffected: rs.rowsAffected };
        },
      });
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback();
      throw err;
    } finally {
      tx.close();
    }
  }

  async close(): Promise<void> {
    this.client.close();
  }
}
