/**
 * The governed SQL surface of the state layer (spec 032 §3.1, §3.3).
 *
 * Every call adjudicates before crossing into Rust, exactly as
 * `backend/kernel/hiq.ts` does for cache and counters. The difference worth
 * naming: those operate on the cache raft group, which is not durable; these
 * operate on the SQLITE group, which is the state layer proper.
 *
 * The consistency choice is in the function name and never in a flag
 * (spec 032 §3.3): a single call with a consistency argument has a default, and
 * the default is silently wrong at half the call sites.
 */
// Import order is load-bearing, as in backend/kernel/hiq.ts: the kernel boots
// (fail-closed) before the addon's module-load raft election starts.
import { demand } from "../kernel/adjudicate";

import hiqlite, { ready } from "../hiq/init";

import { assertPlaceholderOrder } from "./placeholders";
import { SQL_RESOURCE, type SqlOptions } from "./types";
import type { SqlRow, SqlStatement, SqlValue } from "./types";

/**
 * The attribute bundle a db.* grant is narrowed by. Empty unless the caller
 * names the tables it touches.
 *
 * Table narrowing is opt-in on purpose. The kernel checks a `tables` constraint
 * against the request's `table`/`tables` attribute (statecrafting spec 004), so
 * a grant that declares tables denies any call that does not name them. No
 * grant declares tables today, matching the precedent of `cap.db.app.*`, and
 * the facade cannot infer them without parsing SQL, which would make the
 * security boundary depend on a parser. Callers that want the narrowing pass it
 * explicitly, and phase 3 constrains the control plane's grants once its tables
 * are known.
 */
function attrs(opts?: SqlOptions): Record<string, unknown> | undefined {
  if (!opts?.tables || opts.tables.length === 0) return undefined;
  return { tables: opts.tables };
}

/**
 * Read from the LOCAL replica: fast, possibly stale behind the leader.
 *
 * Correct for list and detail endpoints, policy evaluation, and controller
 * scans. NOT correct for admission or for reading the Decision chain head;
 * those take `queryConsistent`.
 */
export async function query<T = SqlRow>(
  sql: string,
  params?: SqlValue[],
  opts?: SqlOptions,
): Promise<T[]> {
  demand("db.read", SQL_RESOURCE, { attributes: attrs(opts) });
  assertPlaceholderOrder(sql);
  await ready;
  return (await hiqlite.query(sql, params)) as T[];
}

/**
 * Read linearizably, through the raft leader. Slower by a round trip.
 *
 * Required wherever a decision is made on what was read.
 */
export async function queryConsistent<T = SqlRow>(
  sql: string,
  params?: SqlValue[],
  opts?: SqlOptions,
): Promise<T[]> {
  demand("db.read", SQL_RESOURCE, { attributes: attrs(opts) });
  assertPlaceholderOrder(sql);
  await ready;
  return (await hiqlite.queryConsistent(sql, params)) as T[];
}

/**
 * A single write. Returns rows affected.
 *
 * For anything with an invariant use `txn`: a resource and its outbox row must
 * commit together, or the event is lost with the resource durably written,
 * which is the exact failure the outbox exists to prevent (spec 032 §3.1).
 */
export async function execute(
  sql: string,
  params?: SqlValue[],
  opts?: SqlOptions,
): Promise<number> {
  demand("db.write", SQL_RESOURCE, { attributes: attrs(opts) });
  assertPlaceholderOrder(sql);
  await ready;
  return hiqlite.execute(sql, params);
}

/** A write with a `RETURNING` clause. Returns the returned rows. */
export async function executeReturning<T = SqlRow>(
  sql: string,
  params?: SqlValue[],
  opts?: SqlOptions,
): Promise<T[]> {
  demand("db.write", SQL_RESOURCE, { attributes: attrs(opts) });
  assertPlaceholderOrder(sql);
  await ready;
  return (await hiqlite.executeReturning(sql, params)) as T[];
}

/**
 * Submit a batch as ONE raft operation: the atomic unit (spec 032 §3.1).
 *
 * This is the write path for anything with an invariant. SQL writes and notify
 * land in different raft groups and cannot be atomic with each other under any
 * API, so this is the only atomic unit available, and it is the one that
 * matters: resource plus outbox row.
 *
 * Adjudicated as `db.txn` rather than as N `db.write`s, because the batch is
 * one effect: a service that may write atomically is making a stronger claim
 * than one that may write, and the model says so.
 */
export async function txn(statements: SqlStatement[], opts?: SqlOptions): Promise<number[]> {
  demand("db.txn", SQL_RESOURCE, { attributes: attrs(opts) });
  for (const s of statements) assertPlaceholderOrder(s.sql);
  await ready;
  return hiqlite.txn(statements);
}
