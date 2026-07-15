/**
 * The CoreLedger driver seam.
 *
 * Everything above this interface (decorators, repositories, schema) is
 * backend-agnostic. v0 ships LibsqlDriver (local SQLite file and Turso
 * embedded replica); a PostgresDriver implements the same interface when
 * scale demands it (docs/ARCHITECTURE.md, thesis).
 */

export type SqlValue = string | number | bigint | boolean | Uint8Array | null;

export type SqlRow = Record<string, SqlValue>;

export interface SqlStatement {
  sql: string;
  params: SqlValue[];
}

export interface ExecuteResult {
  rowsAffected: number;
}

/** The operations available inside and outside a transaction. */
export interface LedgerTx {
  query(sql: string, params?: SqlValue[]): Promise<SqlRow[]>;
  execute(sql: string, params?: SqlValue[]): Promise<ExecuteResult>;
}

export interface LedgerDriver extends LedgerTx {
  readonly dialect: "sqlite" | "postgres";
  /** Run statements as a single transactional batch. */
  batch(statements: SqlStatement[]): Promise<void>;
  /** Interactive transaction; rolls back if `fn` throws. */
  transaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
