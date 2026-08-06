/**
 * The control plane's schema (spec 034 §3.1), as migrations run through the
 * state layer's runner (spec 032 §3.6). DDL is a deploy step, never a boot
 * step.
 *
 * ## One table, `kind` as a column
 *
 * A table per kind would let a grant's `tables` constraint narrow to one kind,
 * which is real and is the argument against what follows. It loses to a
 * stronger one: kinds are data here, not DDL. A kind registered at runtime with
 * no migration is what makes the association domain (phase 5) additive rather
 * than a schema change per resource type, and it is what keeps the watch a
 * single ordered scan instead of a fan-in over N tables whose revisions would
 * have to be reconciled into one order. Grants narrow by kind through the
 * capability's `resource`, which is the axis the kernel already gives us.
 *
 * ## The revision is global and is assigned inside the transaction
 *
 * `revision` is a single monotonic sequence across every resource, not a
 * per-resource counter, because a controller's watermark scan is
 * `revision > watermark ORDER BY revision` over everything it watches. A
 * per-resource counter cannot answer that question.
 *
 * It is computed as `MAX(revision) + 1` INSIDE the admitting transaction, and
 * the alternative is worth recording because it is the obvious one and it is
 * wrong. Bumping a sequence row first and then writing with the value it
 * returned takes two raft operations, so two writers can interleave: W1 takes
 * revision 5, W2 takes 6, W2 commits, W1 commits. A watcher that polls between
 * those commits sees 6, advances its watermark past 5, and never sees W1's
 * write at all. Computing inside the transaction makes revision order and
 * commit order the same order, because raft serializes the transactions, and
 * that identity is the whole basis of the watermark's correctness.
 *
 * This is why deletes are soft. A hard delete could lower `MAX(revision)` and
 * hand the next write a revision a watcher had already passed; a tombstone also
 * happens to be what a watcher needs in order to observe the deletion at all.
 */
import { query, type Migration } from "../state";

export const RESOURCE_TABLE = "resource";
export const OUTBOX_TABLE = "outbox";
export const WATERMARK_TABLE = "controller_watermark";

/** How often a waiter re-asks whether the deploy step has run. */
const SCHEMA_POLL_MS = 5000;

export const CONTROL_PLANE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "control plane: resources, outbox, watermarks",
    statements: [
      `CREATE TABLE IF NOT EXISTS ${RESOURCE_TABLE} (
         kind        TEXT    NOT NULL,
         -- '' for a cluster-scoped kind. An empty string rather than NULL
         -- because it is part of the primary key, and SQLite does not treat
         -- NULLs as equal, so a nullable column would admit duplicate rows for
         -- the same cluster-scoped resource.
         tenant      TEXT    NOT NULL,
         name        TEXT    NOT NULL,
         revision    INTEGER NOT NULL,
         -- The highest fencing token that has written this row. A lease-guarded
         -- writer carries its token and the admitting predicate rejects a token
         -- below this, so a zombie holder's writes fail (spec 032 §3.4).
         fence       INTEGER NOT NULL DEFAULT 0,
         spec        TEXT    NOT NULL,
         -- Controller-owned. Separated from spec so that a reconcile writing
         -- status cannot silently clobber an operator's concurrent intent.
         status      TEXT,
         deleted_at  TEXT,
         created_at  TEXT    NOT NULL,
         updated_at  TEXT    NOT NULL,
         PRIMARY KEY (kind, tenant, name)
       )`,
      // The watch's only access path: ordered by the global sequence.
      `CREATE INDEX IF NOT EXISTS ${RESOURCE_TABLE}_revision
         ON ${RESOURCE_TABLE} (revision)`,
      // Listing a kind within a tenant, which is every list endpoint.
      `CREATE INDEX IF NOT EXISTS ${RESOURCE_TABLE}_kind_tenant
         ON ${RESOURCE_TABLE} (kind, tenant)`,
      `CREATE TABLE IF NOT EXISTS ${OUTBOX_TABLE} (
         -- The same revision the resource row got, which is what makes the
         -- outbox row and the resource write one atomic unit worth having
         -- (spec 032 §3.1) rather than two rows that usually agree.
         revision INTEGER PRIMARY KEY,
         kind     TEXT NOT NULL,
         tenant   TEXT NOT NULL,
         name     TEXT NOT NULL,
         op       TEXT NOT NULL,
         at       TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS ${WATERMARK_TABLE} (
         controller TEXT PRIMARY KEY,
         revision   INTEGER NOT NULL,
         updated_at TEXT    NOT NULL
       )`,
    ],
  },
];

/**
 * Whether the control plane's tables exist yet.
 *
 * Asked of `sqlite_master` rather than by catching a failed read, so the answer
 * separates two states a caught exception would merge: "the deploy step has not
 * run" is a precondition to wait on, while "the store is unreachable" is a fault
 * to report. A `catch` around a real query calls both of them the same thing.
 *
 * One migration creates all three tables in a single transaction, so they arrive
 * together and either one answers for the set. It asks for both tables a
 * controller reads because the cost is the same row scan and the answer then
 * does not depend on which table the caller happens to touch first.
 */
export async function controlSchemaPresent(): Promise<boolean> {
  const rows = await query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ($1, $2)`,
    [RESOURCE_TABLE, WATERMARK_TABLE],
    { tables: ["sqlite_master"] },
  );
  return rows.length === 2;
}

export interface SchemaWait {
  /** Resolves true once the tables exist, false if `cancel()` won the race. */
  readonly done: Promise<boolean>;
  /** Give up waiting. Used by a loop's `stop()` so shutdown does not block. */
  cancel(): void;
}

/**
 * Wait for the control plane's schema, polling until it appears.
 *
 * **This exists because a missing precondition is a state, not a fault.**
 * Migration is a deploy step and never a boot step (spec 032 §3.6), so a freshly
 * provisioned cell legitimately runs for a while with no control-plane tables.
 * A loop that discovers this by failing a pass every tick logs an error per
 * second forever, and the operator it is addressing learns to ignore the log:
 * the noise trains exactly the reflex that makes the next real error invisible.
 * Waiting says the same thing once and then says nothing.
 *
 * Returned as a cancellable handle rather than a bare promise because every
 * caller is a loop with a `stop()`, and a shutdown that has to outlast a poll
 * interval is a shutdown that looks hung.
 *
 * **A failing probe keeps waiting rather than escaping.** The loops this gates
 * previously caught every store error per pass and continued, and a gate that
 * propagated one would have converted a transient into a permanently dead
 * controller: a worse failure than the noise it replaces, and a silent one.
 * The fault still gets said out loud through `onProbeError`, once per distinct
 * message, which is what keeps it from being confused with a missing table.
 */
export function awaitControlSchema(
  opts: { pollMs?: number; onWaiting?: () => void; onProbeError?: (err: unknown) => void } = {},
): SchemaWait {
  const pollMs = opts.pollMs ?? SCHEMA_POLL_MS;
  let cancelled = false;
  let wake: (() => void) | undefined;
  let lastError: string | undefined;

  async function probe(): Promise<boolean> {
    try {
      return await controlSchemaPresent();
    } catch (err) {
      // Repeating an unchanging fault at the poll cadence is the same mistake
      // this gate exists to undo, one interval slower.
      const message = String(err);
      if (message !== lastError) {
        lastError = message;
        opts.onProbeError?.(err);
      }
      return false;
    }
  }

  const done = (async (): Promise<boolean> => {
    if (await probe()) return true;
    if (cancelled) return false;
    opts.onWaiting?.();

    while (!cancelled) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, pollMs);
        function finish(): void {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        }
        wake = finish;
      });
      if (cancelled) return false;
      if (await probe()) return true;
    }
    return false;
  })();

  return {
    done,
    cancel(): void {
      cancelled = true;
      wake?.();
    },
  };
}
