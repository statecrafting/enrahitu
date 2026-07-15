/**
 * Typed repository over one entity.
 *
 * The codec boundary lives here: JS values in entity fields <-> SqlValue in
 * the driver. Query surface is deliberately small (equality WHERE, ordering,
 * limit/offset); anything richer goes through the Ledger's raw query/execute
 * escape hatch with explicit SQL.
 */

import type { LedgerTx, SqlRow, SqlValue } from "./driver";
import type { ColumnMeta, EntityCtor, EntityMeta } from "./metadata";

export interface FindOptions<T> {
  orderBy?: keyof T & string;
  direction?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

function toSql(value: unknown, col: ColumnMeta): SqlValue {
  if (value === null || value === undefined) {
    if (!col.nullable && !col.primary) {
      throw new Error(`CoreLedger: column "${col.name}" is NOT NULL but got ${value}`);
    }
    return null;
  }
  switch (col.type) {
    case "boolean":
      return value ? 1 : 0;
    case "json":
      return JSON.stringify(value);
    case "timestamp": {
      const date = value instanceof Date ? value : new Date(value as string);
      if (Number.isNaN(date.getTime())) {
        throw new Error(`CoreLedger: column "${col.name}" got an invalid timestamp`);
      }
      return date.toISOString();
    }
    case "integer":
    case "real":
      return value as number | bigint;
    case "blob":
      return value as Uint8Array;
    case "text":
      return String(value);
  }
}

function fromSql(value: SqlValue, col: ColumnMeta): unknown {
  if (value === null) return null;
  switch (col.type) {
    case "boolean":
      return Number(value) !== 0;
    case "json":
      return JSON.parse(String(value));
    case "timestamp":
      return new Date(String(value));
    case "integer":
    case "real":
      return typeof value === "bigint" ? value : Number(value);
    case "blob":
      return value;
    case "text":
      return String(value);
  }
}

export class Repository<T extends object> {
  constructor(
    private readonly tx: LedgerTx,
    private readonly meta: EntityMeta,
    private readonly ctor: EntityCtor<T>,
  ) {}

  private column(property: string): ColumnMeta {
    const col = this.meta.columns.find((c) => c.property === property);
    if (!col) {
      throw new Error(
        `CoreLedger: ${this.ctor.name} has no @Column property "${property}"`,
      );
    }
    return col;
  }

  private hydrate(row: SqlRow): T {
    const instance = new this.ctor();
    for (const col of this.meta.columns) {
      (instance as Record<string, unknown>)[col.property] = fromSql(row[col.name] ?? null, col);
    }
    return instance;
  }

  /** Build `WHERE a = ? AND b IS NULL` from an equality map of properties. */
  private where(criteria: Partial<T>): { clause: string; params: SqlValue[] } {
    const entries = Object.entries(criteria);
    if (entries.length === 0) return { clause: "", params: [] };
    const fragments: string[] = [];
    const params: SqlValue[] = [];
    for (const [property, value] of entries) {
      const col = this.column(property);
      if (value === null || value === undefined) {
        fragments.push(`"${col.name}" IS NULL`);
      } else {
        fragments.push(`"${col.name}" = ?`);
        params.push(toSql(value, col));
      }
    }
    return { clause: ` WHERE ${fragments.join(" AND ")}`, params };
  }

  async insert(entity: T): Promise<T> {
    const cols = this.meta.columns;
    const names = cols.map((c) => `"${c.name}"`).join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    const params = cols.map((c) => toSql((entity as Record<string, unknown>)[c.property], c));
    await this.tx.execute(
      `INSERT INTO "${this.meta.table}" (${names}) VALUES (${placeholders})`,
      params,
    );
    return entity;
  }

  async findById(id: string | number | bigint): Promise<T | null> {
    const pk = this.meta.primary;
    const rows = await this.tx.query(
      `SELECT * FROM "${this.meta.table}" WHERE "${pk.name}" = ? LIMIT 1`,
      [toSql(id, pk)],
    );
    return rows.length > 0 ? this.hydrate(rows[0]) : null;
  }

  async findOne(criteria: Partial<T>): Promise<T | null> {
    const results = await this.findWhere(criteria, { limit: 1 });
    return results[0] ?? null;
  }

  async findWhere(criteria: Partial<T>, options: FindOptions<T> = {}): Promise<T[]> {
    const { clause, params } = this.where(criteria);
    let sql = `SELECT * FROM "${this.meta.table}"${clause}`;
    if (options.orderBy) {
      const col = this.column(options.orderBy);
      sql += ` ORDER BY "${col.name}" ${options.direction === "desc" ? "DESC" : "ASC"}`;
    }
    if (options.limit !== undefined) {
      sql += ` LIMIT ${Math.floor(options.limit)}`;
      if (options.offset !== undefined) sql += ` OFFSET ${Math.floor(options.offset)}`;
    }
    const rows = await this.tx.query(sql, params);
    return rows.map((row) => this.hydrate(row));
  }

  async updateById(id: string | number | bigint, patch: Partial<T>): Promise<boolean> {
    const entries = Object.entries(patch);
    if (entries.length === 0) return false;
    const pk = this.meta.primary;
    const assignments: string[] = [];
    const params: SqlValue[] = [];
    for (const [property, value] of entries) {
      const col = this.column(property);
      if (col.primary) {
        throw new Error(`CoreLedger: refusing to update primary key "${col.name}"`);
      }
      assignments.push(`"${col.name}" = ?`);
      params.push(toSql(value, col));
    }
    params.push(toSql(id, pk));
    const result = await this.tx.execute(
      `UPDATE "${this.meta.table}" SET ${assignments.join(", ")} WHERE "${pk.name}" = ?`,
      params,
    );
    return result.rowsAffected > 0;
  }

  async deleteById(id: string | number | bigint): Promise<boolean> {
    const pk = this.meta.primary;
    const result = await this.tx.execute(
      `DELETE FROM "${this.meta.table}" WHERE "${pk.name}" = ?`,
      [toSql(id, pk)],
    );
    return result.rowsAffected > 0;
  }

  async count(criteria: Partial<T> = {}): Promise<number> {
    const { clause, params } = this.where(criteria);
    const rows = await this.tx.query(
      `SELECT COUNT(*) AS n FROM "${this.meta.table}"${clause}`,
      params,
    );
    return Number(rows[0]?.n ?? 0);
  }
}
