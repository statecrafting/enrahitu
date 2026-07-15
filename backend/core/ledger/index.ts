/**
 * CoreLedger: durable relational data behind a decorator surface.
 *
 * Local SQLite file by default, Turso embedded replica via env, managed
 * Postgres behind the same interface when scale demands it.
 *
 * ```ts
 * @Entity("users")
 * class User {
 *   @Column({ primary: true }) id = "";
 *   @Column({ unique: true }) email = "";
 *   @Column({ type: "boolean" }) active = true;
 *   @Column({ type: "timestamp" }) createdAt = new Date();
 * }
 *
 * await ledger().init();
 * const users = ledger().repo(User);
 * await users.insert(Object.assign(new User(), { id: "u1", email: "a@b.c" }));
 * ```
 */

export { Column, Entity, type ColumnOptions } from "./decorators";
export {
  allEntities,
  entityMeta,
  type ColumnMeta,
  type ColumnType,
  type EntityCtor,
  type EntityMeta,
} from "./metadata";
export type {
  ExecuteResult,
  LedgerDriver,
  LedgerTx,
  SqlRow,
  SqlStatement,
  SqlValue,
} from "./driver";
export { LibsqlDriver, type LibsqlConfig } from "./libsql";
export { PostgresDriver, type PostgresConfig, translatePlaceholders } from "./postgres";
export { createTableSql, ensureSchema, sqlType, quoteIdent, type Dialect } from "./schema";
export { appliedVersions, migrate, addColumnSql, type Migration } from "./migrations";
export { Repository, type FindOptions } from "./repository";
export { Ledger, ledger } from "./ledger";
