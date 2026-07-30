/**
 * Admission (spec 034 §3.3): the only path by which a resource changes.
 *
 * Every mutation runs the same five steps, in this order, and the order is the
 * design:
 *
 *   1. validate  : the kind's validator normalizes the spec, or refuses it
 *   2. adjudicate: the state facade demands the capability before crossing
 *                  into Rust (spec 032), so a denial costs no write
 *   3. commit    : the resource row and its outbox row in ONE txn, with the
 *                  global revision assigned inside it (spec 034 §3.1)
 *   4. read back : the revision the row actually got
 *   5. notify    : a key-only hint on the cache group, AFTER the commit
 *
 * Notify is step 5 and never step 3.5. SQL writes and notify land in different
 * raft groups and cannot be atomic with each other under any API (spec 032
 * §3.1), so a notify issued inside the write path would announce a commit that
 * might not happen. Issued after, the worst case is a commit whose notify is
 * lost, which the watermark scan recovers from by design.
 *
 * ## Capability granularity
 *
 * Admission's capability check is the state facade's: `db.txn` on `state` for a
 * write, `db.read` for a read. It is the STORE that is granted, not the kind.
 *
 * Per-kind grants would be better and are deliberately not here yet. The
 * kernel's narrowing axis for `db.*` is the `tables` constraint, and every kind
 * shares one `resource` table (spec 034 §3.1), so the axis buys nothing as the
 * schema stands. Making a kind its own capability resource means declaring each
 * kind in the model, which is a contract question rather than an implementation
 * one. Spec 020 §3.4 already carries per-verb and per-table attribution as a
 * named v0.2 extension; per-kind admission grants belong in that same list, and
 * phase 4's boundary work is where it lands.
 */
import { receipt } from "../kernel/boot";
import { appendDecision, contextHash } from "../kernel/decisions";
import { notify, query, queryConsistent, txn } from "../state";

import { requireKind, type Kind } from "./kinds";
import { hydrateRow, type ResourceRow } from "./rows";
import { OUTBOX_TABLE, RESOURCE_TABLE } from "./schema";

/** A stored resource, as admission and the watch return it. */
export interface Resource<TSpec = unknown> {
  kind: string;
  tenant: string;
  name: string;
  revision: number;
  fence: number;
  spec: TSpec;
  status: unknown;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type Op = "created" | "updated" | "deleted";

export interface AdmitOptions {
  /** Required for a tenant-scoped kind, refused for a cluster-scoped one. */
  tenant?: string;
  /**
   * The fencing token of a held lease (spec 032 §3.4). A write carrying a token
   * below the row's high-water mark is refused, which is how a controller that
   * lost its lease mid-reconcile learns it was superseded.
   */
  fence?: number;
  /** Who asked. Recorded on the Decision, not on the row. */
  actor?: string;
}

/** Thrown when a lease-guarded write loses to a newer holder. */
export class SupersededError extends Error {
  constructor(
    readonly kind: string,
    readonly name: string,
    readonly fence: number,
  ) {
    super(
      `write to ${kind}/${name} carried fence ${fence}, which is below the fence already recorded: another holder has the lease`,
    );
    this.name = "SupersededError";
  }
}

/** Thrown when a tenant argument disagrees with the kind's tenancy. */
export class TenancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenancyError";
  }
}

function tenantOf(kind: Kind<unknown>, opts: AdmitOptions): string {
  if (kind.tenantScoped) {
    if (!opts.tenant) {
      throw new TenancyError(`kind '${kind.name}' is tenant-scoped and no tenant was given`);
    }
    return opts.tenant;
  }
  if (opts.tenant) {
    throw new TenancyError(
      `kind '${kind.name}' is cluster-scoped; a tenant ('${opts.tenant}') is not meaningful for it`,
    );
  }
  return "";
}

const SELECT_ONE = `SELECT * FROM ${RESOURCE_TABLE} WHERE kind = $1 AND tenant = $2 AND name = $3`;

/**
 * The next global revision, computed inside the statement that uses it.
 *
 * Not a sequence table read beforehand: that takes two raft operations and lets
 * two writers commit out of revision order, which silently breaks every
 * watermark scan (spec 034 §3.1 records the failure in full).
 */
const NEXT_REVISION = `(SELECT COALESCE(MAX(revision), 0) + 1 FROM ${RESOURCE_TABLE})`;

/**
 * Admit a create-or-update. Returns the resource as stored, at the revision the
 * write produced.
 */
export async function admit<TSpec>(
  kindName: string,
  name: string,
  spec: unknown,
  opts: AdmitOptions = {},
): Promise<Resource<TSpec>> {
  const kind = requireKind(kindName);
  const tenant = tenantOf(kind, opts);
  const validated = kind.validate(spec);
  const fence = opts.fence ?? 0;
  const now = new Date().toISOString();
  const body = JSON.stringify(validated);

  const before = await queryConsistent<ResourceRow>(SELECT_ONE, [kind.name, tenant, name], {
    tables: [RESOURCE_TABLE],
  });
  const existing = before[0];
  if (existing && Number(existing.fence) > fence) {
    throw new SupersededError(kind.name, name, fence);
  }

  // An admission that changes nothing is not an admission.
  //
  // This is what makes a converged controller quiescent, and without it the
  // control plane does not work at all: a controller that writes a resource it
  // also watches sees its own write as a new revision, reconciles again, writes
  // again, and spins for as long as its lease allows. Kubernetes controllers
  // survive the same shape by not writing when the desired value is already
  // stored, so the store enforces it here rather than leaving every reconciler
  // to remember.
  //
  // The comparison is over the NORMALIZED spec, which is why the validator
  // returns a value rather than a verdict: two inputs that normalize to the same
  // resource are the same resource, whatever whitespace they arrived with.
  if (existing && !existing.deleted_at && existing.spec === body && Number(existing.fence) === fence) {
    return hydrateRow<TSpec>(existing);
  }

  const op: Op = existing && !existing.deleted_at ? "updated" : "created";

  await txn(
    [
      {
        sql: `INSERT INTO ${RESOURCE_TABLE}
                (kind, tenant, name, revision, fence, spec, status, deleted_at, created_at, updated_at)
              VALUES ($1, $2, $3, ${NEXT_REVISION}, $4, $5, NULL, NULL, $6, $6)
              ON CONFLICT (kind, tenant, name) DO UPDATE SET
                revision   = ${NEXT_REVISION},
                fence      = excluded.fence,
                spec       = excluded.spec,
                deleted_at = NULL,
                updated_at = excluded.updated_at
              WHERE ${RESOURCE_TABLE}.fence <= excluded.fence`,
        params: [kind.name, tenant, name, fence, body, now],
      },
      {
        // Takes the revision the row now holds, so the two rows cannot
        // disagree about which write they describe.
        //
        // Placeholder numbering is ascending by first appearance, which the
        // store requires and does not check: parameters bind in appearance
        // order and the number is ignored, so `... $4 ... WHERE kind = $1`
        // would bind the op to `kind` and match nothing, silently (spec 034
        // §3.6). That is why `op` and `at` are numbered before the key columns
        // here even though they are read later.
        sql: `INSERT INTO ${OUTBOX_TABLE} (revision, kind, tenant, name, op, at)
              SELECT revision, kind, tenant, name, $1, $2 FROM ${RESOURCE_TABLE}
               WHERE kind = $3 AND tenant = $4 AND name = $5`,
        params: [op, now, kind.name, tenant, name],
      },
    ],
    { tables: [RESOURCE_TABLE, OUTBOX_TABLE] },
  );

  const stored = await readBack<TSpec>(kind.name, tenant, name);
  await record(kind.name, tenant, name, op, stored.revision, opts.actor);
  await notify({ kind: kind.name, tenant: tenant || undefined, name, revision: stored.revision });
  return stored;
}

/**
 * Retract a resource: a tombstone, not a delete.
 *
 * The row stays so that a watcher observes the retraction (a row that vanishes
 * is indistinguishable from one it never saw), and so that `MAX(revision)`
 * cannot regress and hand a later write a revision a watcher has already passed.
 */
export async function retract<TSpec>(
  kindName: string,
  name: string,
  opts: AdmitOptions = {},
): Promise<Resource<TSpec> | null> {
  const kind = requireKind(kindName);
  const tenant = tenantOf(kind, opts);
  const fence = opts.fence ?? 0;
  const now = new Date().toISOString();

  const before = await queryConsistent<ResourceRow>(SELECT_ONE, [kind.name, tenant, name], {
    tables: [RESOURCE_TABLE],
  });
  const existing = before[0];
  if (!existing || existing.deleted_at) return null;
  if (Number(existing.fence) > fence) throw new SupersededError(kind.name, name, fence);

  await txn(
    [
      {
        // Numbered ascending by first appearance; see the note in `admit`.
        sql: `UPDATE ${RESOURCE_TABLE}
                 SET revision = ${NEXT_REVISION}, deleted_at = $1, updated_at = $1, fence = $2
               WHERE kind = $3 AND tenant = $4 AND name = $5 AND fence <= $2`,
        params: [now, fence, kind.name, tenant, name],
      },
      {
        sql: `INSERT INTO ${OUTBOX_TABLE} (revision, kind, tenant, name, op, at)
              SELECT revision, kind, tenant, name, 'deleted', $1 FROM ${RESOURCE_TABLE}
               WHERE kind = $2 AND tenant = $3 AND name = $4`,
        params: [now, kind.name, tenant, name],
      },
    ],
    { tables: [RESOURCE_TABLE, OUTBOX_TABLE] },
  );

  const stored = await readBack<TSpec>(kind.name, tenant, name);
  await record(kind.name, tenant, name, "deleted", stored.revision, opts.actor);
  await notify({ kind: kind.name, tenant: tenant || undefined, name, revision: stored.revision });
  return stored;
}

/**
 * Write a resource's observed state (spec 036 §3.5, amending spec 034 §5).
 *
 * `admit` writes intent. Its `ON CONFLICT` clause sets revision, fence, spec,
 * deleted_at and updated_at, and deliberately never `status`, so a reconcile
 * writing what it observed cannot clobber an operator's concurrent change to
 * what they want. That left `status` readable and unwritable until the first
 * controller needed it.
 *
 * The same five steps in the same order, minus validation: status is the
 * controller's own shape rather than the kind's declared one, and giving the
 * kind registry a second validator vocabulary would make a kind describe two
 * different things.
 *
 * The no-op rule matters MORE here than it does for spec writes. A reconciler
 * writes status to a kind it also watches, which is not an edge case but the
 * normal shape of every controller in the domain: without the early return, each
 * reconcile produces the change that triggers the next one and the loop spins
 * until its lease expires (spec 034 §3.3).
 */
export async function setStatus<TSpec>(
  kindName: string,
  name: string,
  status: unknown,
  opts: AdmitOptions = {},
): Promise<Resource<TSpec> | null> {
  const kind = requireKind(kindName);
  const tenant = tenantOf(kind, opts);
  const fence = opts.fence ?? 0;
  const now = new Date().toISOString();
  const body = JSON.stringify(status);

  const before = await queryConsistent<ResourceRow>(SELECT_ONE, [kind.name, tenant, name], {
    tables: [RESOURCE_TABLE],
  });
  const existing = before[0];
  if (!existing || existing.deleted_at) return null;
  if (Number(existing.fence) > fence) throw new SupersededError(kind.name, name, fence);
  if (existing.status === body) return hydrateRow<TSpec>(existing);

  await txn(
    [
      {
        // Numbered ascending by first appearance; `$2` recurs in the predicate,
        // which is the normal way to bind one value twice (spec 034 §3.6).
        sql: `UPDATE ${RESOURCE_TABLE}
                 SET revision = ${NEXT_REVISION}, status = $1, fence = $2, updated_at = $3
               WHERE kind = $4 AND tenant = $5 AND name = $6 AND fence <= $2`,
        params: [body, fence, now, kind.name, tenant, name],
      },
      {
        sql: `INSERT INTO ${OUTBOX_TABLE} (revision, kind, tenant, name, op, at)
              SELECT revision, kind, tenant, name, 'updated', $1 FROM ${RESOURCE_TABLE}
               WHERE kind = $2 AND tenant = $3 AND name = $4`,
        params: [now, kind.name, tenant, name],
      },
    ],
    { tables: [RESOURCE_TABLE, OUTBOX_TABLE] },
  );

  const stored = await readBack<TSpec>(kind.name, tenant, name);
  await record(kind.name, tenant, name, "updated", stored.revision, opts.actor, "status");
  await notify({ kind: kind.name, tenant: tenant || undefined, name, revision: stored.revision });
  return stored;
}

async function readBack<TSpec>(kind: string, tenant: string, name: string): Promise<Resource<TSpec>> {
  const rows = await queryConsistent<ResourceRow>(SELECT_ONE, [kind, tenant, name], {
    tables: [RESOURCE_TABLE],
  });
  const row = rows[0];
  if (!row) {
    throw new Error(`admitted ${kind}/${name} but it was not readable afterwards`);
  }
  return hydrateRow<TSpec>(row);
}

/**
 * Append the admission to the Decision chain.
 *
 * Denials already append through the kernel (spec 021 §3.6); this is the other
 * half, so the chain records what was allowed and not only what was refused. A
 * ledger that holds only denials answers "what was stopped" and cannot answer
 * "who changed this", which is the question a board minute or a grant audit
 * actually asks.
 */
async function record(
  kind: string,
  tenant: string,
  name: string,
  op: Op,
  revision: number,
  actor: string | undefined,
  column: "spec" | "status" = "spec",
): Promise<void> {
  const context: Record<string, unknown> = { kind, name, op, revision, tenant };
  // Present only on a status write, so the context of every spec write hashes
  // exactly as it did before this field existed. A record's preimage is not
  // something to change for tidiness: the chain cannot tell a new shape from a
  // tampered one.
  if (column === "status") context.column = "status";
  if (actor) context.actor = actor;
  await appendDecision({
    modelHash: receipt.modelHash,
    gateConfigHash: receipt.gateConfigHash,
    service: "control",
    // The kernel's kind vocabulary governs what may be ENFORCED; this is a
    // record of something already allowed, and the chain's capability ref is
    // descriptive here rather than adjudicated. The adjudication that gated
    // this write already happened, as `db.txn` on `state`, one frame down.
    capability: { kind: `resource.${op}`, resource: kind },
    contextHash: contextHash(context),
    outcome: "allow",
    reason: `${column === "status" ? "status" : "admitted"}:${kind}/${tenant || "-"}/${name}@${revision}`,
    checkIds: [],
  });
}

/** Read one resource. Local replica: correct for detail endpoints (spec 032 §3.3). */
export async function get<TSpec>(
  kindName: string,
  name: string,
  opts: AdmitOptions = {},
): Promise<Resource<TSpec> | null> {
  const kind = requireKind(kindName);
  const tenant = tenantOf(kind, opts);
  const rows = await query<ResourceRow>(SELECT_ONE, [kind.name, tenant, name], {
    tables: [RESOURCE_TABLE],
  });
  const row = rows[0];
  if (!row || row.deleted_at) return null;
  return hydrateRow<TSpec>(row);
}

/** List the live resources of a kind, oldest revision first. */
export async function list<TSpec>(
  kindName: string,
  opts: AdmitOptions = {},
): Promise<Resource<TSpec>[]> {
  const kind = requireKind(kindName);
  const tenant = tenantOf(kind, opts);
  const rows = await query<ResourceRow>(
    `SELECT * FROM ${RESOURCE_TABLE}
      WHERE kind = $1 AND tenant = $2 AND deleted_at IS NULL
      ORDER BY revision`,
    [kind.name, tenant],
    { tables: [RESOURCE_TABLE] },
  );
  return rows.map((r) => hydrateRow<TSpec>(r));
}
