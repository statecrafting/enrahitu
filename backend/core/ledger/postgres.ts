/**
 * Postgres driver: the same `LedgerDriver` interface as libSQL, over a single
 * `pg` connection pool (spec 011).
 *
 * The control plane (itself an EnRaHiTu app) runs CoreLedger on Postgres while
 * stamped apps run it on libSQL/Turso. Nothing above this file changes: the
 * decorators, repositories, and the codec in `repository.ts` are byte-for-byte
 * identical across drivers. This driver owns the two things that actually
 * differ between the dialects at the wire: placeholder syntax (libSQL `?` vs
 * Postgres `$n`) and the storage type names (schema.ts).
 *
 * The `pg` client is imported default-then-destructured (`const { Pool } =
 * pg`) rather than as a named import: pg is CommonJS, and this form resolves
 * identically under tsc, vitest/vite, and the encore bundler.
 */

import pg from "pg";
import type { Pool as PgPool, QueryResult } from "pg";

import type {
  ExecuteResult,
  LedgerDriver,
  LedgerTx,
  SqlRow,
  SqlStatement,
  SqlValue,
} from "./driver";

const { Pool } = pg;

export interface PostgresConfig {
  /** A `postgres://` / `postgresql://` connection string. */
  url: string;
  /** `pg.Pool` max connections; sized for the single-container shape. */
  poolSize?: number;
}

/**
 * Rewrite libSQL-style positional `?` markers to Postgres `$1..$n`.
 *
 * A `?` is only a placeholder in code position: this scanner copies past
 * single-quoted strings, double-quoted identifiers, and `--` / block comments
 * untouched, so a literal like `'why?'` or an identifier is never rewritten.
 * The JSONB existence operators `?`, `?|`, `?&` are ambiguous with a bare
 * placeholder; the multi-character forms are left alone, and a lone `?` is
 * always treated as a placeholder (CoreLedger never emits the bare `?`
 * operator; a query that needs it uses the raw pool or `jsonb_exists()`).
 */
export function translatePlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];

    // Single-quoted string literal ('' escapes an inner quote).
    if (ch === "'") {
      out += ch;
      i++;
      while (i < len) {
        out += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Double-quoted identifier ("" escapes an inner quote).
    if (ch === '"') {
      out += ch;
      i++;
      while (i < len) {
        out += sql[i];
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Line comment: -- ... EOL
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < len && sql[i] !== "\n") {
        out += sql[i];
        i++;
      }
      continue;
    }

    // Block comment: /* ... */
    if (ch === "/" && sql[i + 1] === "*") {
      out += "/*";
      i += 2;
      while (i < len && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out += sql[i];
        i++;
      }
      if (i < len) {
        out += "*/";
        i += 2;
      }
      continue;
    }

    if (ch === "?") {
      const next = sql[i + 1];
      // JSONB operators ?|, ?&, ?? are operators, not placeholders.
      if (next === "|" || next === "&" || next === "?") {
        out += ch;
        out += next;
        i += 2;
        continue;
      }
      n++;
      out += `$${n}`;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Bind-value coercion at the `pg` boundary. `pg` wants a `Buffer` for BYTEA
 * (a bare `Uint8Array` would stringify), and `bigint` is passed as text so it
 * survives regardless of the pg version's BigInt handling.
 */
function normalizeParam(value: SqlValue): unknown {
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

function normalizeParams(params: SqlValue[]): unknown[] {
  return params.map(normalizeParam);
}

function rowsOf(result: QueryResult): SqlRow[] {
  // CoreLedger's own schema only produces string / number / boolean / Buffer /
  // null column values (all SqlValue-shaped); pg returns them as-is.
  return result.rows as SqlRow[];
}

export class PostgresDriver implements LedgerDriver {
  readonly dialect = "postgres" as const;
  private readonly pool: PgPool;

  constructor(config: PostgresConfig) {
    this.pool = new Pool({
      connectionString: config.url,
      max: config.poolSize ?? 10,
    });
  }

  async query(sql: string, params: SqlValue[] = []): Promise<SqlRow[]> {
    return rowsOf(await this.pool.query(translatePlaceholders(sql), normalizeParams(params)));
  }

  async execute(sql: string, params: SqlValue[] = []): Promise<ExecuteResult> {
    const result = await this.pool.query(translatePlaceholders(sql), normalizeParams(params));
    return { rowsAffected: result.rowCount ?? 0 };
  }

  async batch(statements: SqlStatement[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const statement of statements) {
        await client.query(translatePlaceholders(statement.sql), normalizeParams(statement.params));
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async transaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: LedgerTx = {
      query: async (sql, params = []) =>
        rowsOf(await client.query(translatePlaceholders(sql), normalizeParams(params))),
      execute: async (sql, params = []) => {
        const result = await client.query(translatePlaceholders(sql), normalizeParams(params));
        return { rowsAffected: result.rowCount ?? 0 };
      },
    };
    try {
      await client.query("BEGIN");
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
