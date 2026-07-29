/**
 * The state layer's type surface and its resource names (spec 032 §4).
 *
 * The SQL value types come from the addon so the two cannot drift: a change to
 * what crosses the napi boundary is a compile error here rather than a runtime
 * surprise.
 */
export type { BackupListing, NotifyEnvelope, SqlRow, SqlStatement, SqlValue } from "@statecrafting/hiqlite-native";

/**
 * The resource name every SQL capability is granted on.
 *
 * One resource, not one per table. The kernel's resource dimension names the
 * store; table-level narrowing is the `tables` constraint on a grant, which is
 * a different axis (see `sql.ts`).
 */
export const SQL_RESOURCE = "state";

/**
 * The resource name the backup capabilities are granted on.
 *
 * It covers the local backup directory and the S3 prefix together, because they
 * are two views of one backup set: hiqlite writes the local file and pushes the
 * same object, and an operator listing "the backups" means both.
 */
export const BACKUP_RESOURCE = "state-backups";

/**
 * The resource name the lease and watch capabilities are granted on.
 *
 * Deliberately the SQL store's name rather than a separate one. The fence
 * counter lives in the SQLITE group and commits with the writes it guards
 * (spec 032 §3.4 implementation record), and a notify names a row in that same
 * store, so a grant to lease or watch is a grant over `state` and reads that
 * way in the model.
 */
export const COORD_RESOURCE = SQL_RESOURCE;

/** Optional narrowing passed to a SQL call so a `tables`-constrained grant can match. */
export interface SqlOptions {
  /** The tables this statement touches, named by the caller. */
  tables?: string[];
}

/** Removes a `listen` handler. Idempotent. */
export type Unsubscribe = () => void;
