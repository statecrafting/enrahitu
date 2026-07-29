/**
 * Schema migration for the state layer (spec 032 §3.6).
 *
 * The addon exposes no migrate entry point, deliberately. Leader-only is not
 * something to implement: every write already goes through the leader, so it is
 * a property of the store rather than a feature of the migrator. What remains
 * is version comparison, ordering, and idempotence, which is policy, and policy
 * belongs in application code where it is testable and reviewable. An addon
 * entry point would freeze that policy into a binary shipping on a different
 * cadence.
 *
 * **This is a deploy step, not a boot step** (spec 027 §3.4). Boot-time
 * migration ties schema change to process restart, so a crash loop becomes a
 * migration loop; and once a topology runs more than one container against one
 * store, boot-time migration races. This runner survives the race by
 * construction, because `version` is the primary key and each migration shares
 * its transaction with the recording insert, so a concurrent loser rolls back
 * whole. Surviving a race is not a reason to run one.
 */
import { demand } from "../kernel/adjudicate";

import hiqlite, { ready } from "../hiq/init";

import { SQL_RESOURCE } from "./types";

/** The table recording what has been applied. Underscore-prefixed: infrastructure, not domain. */
export const MIGRATIONS_TABLE = "_state_migrations";

export interface Migration {
  /** Unique and ascending. Gaps are allowed; duplicates and reordering are not. */
  version: number;
  name: string;
  /** DDL and data statements, applied in order inside one transaction. */
  statements: string[];
}

export interface AppliedMigration {
  version: number;
  name: string;
}

/**
 * Refuse a migration list that cannot be reasoned about, before touching the
 * store. A duplicate version silently skips a migration once its twin is
 * recorded, and a descending list applies in an order the version column then
 * misreports; both are worse found here than in production.
 */
function validate(migrations: Migration[]): void {
  let previous = Number.NEGATIVE_INFINITY;
  const seen = new Set<number>();
  for (const m of migrations) {
    if (!Number.isInteger(m.version)) {
      throw new Error(`migration '${m.name}' has a non-integer version ${m.version}`);
    }
    if (seen.has(m.version)) {
      throw new Error(`duplicate migration version ${m.version} ('${m.name}')`);
    }
    if (m.version <= previous) {
      throw new Error(
        `migration versions must ascend: ${m.version} ('${m.name}') follows ${previous}`,
      );
    }
    if (m.statements.length === 0) {
      throw new Error(`migration ${m.version} ('${m.name}') has no statements`);
    }
    seen.add(m.version);
    previous = m.version;
  }
}

/**
 * Apply every migration not yet recorded, in order. Returns those applied.
 *
 * Adjudicated once, as one `db.migrate` effect, then executed with the addon
 * directly: the internal reads and transactions are the mechanism of the effect
 * the caller already asked for, and re-adjudicating each would report several
 * decisions for one act and require the caller to hold `db.read` and `db.txn`
 * to be allowed to migrate.
 */
export async function migrate(migrations: Migration[]): Promise<AppliedMigration[]> {
  demand("db.migrate", SQL_RESOURCE);
  validate(migrations);
  await ready;

  await hiqlite.txn([
    {
      sql: `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
              version    INTEGER PRIMARY KEY,
              name       TEXT NOT NULL,
              applied_at TEXT NOT NULL
            )`,
    },
  ]);

  // Consistent, not local: the decision to skip or apply is made on what is
  // read, which is exactly the line spec 032 §3.3 draws.
  const rows = await hiqlite.queryConsistent(`SELECT version FROM ${MIGRATIONS_TABLE}`);
  const applied = new Set(rows.map((r) => Number(r.version)));

  const result: AppliedMigration[] = [];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    await hiqlite.txn([
      ...m.statements.map((sql) => ({ sql })),
      {
        sql: `INSERT INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES ($1, $2, $3)`,
        params: [m.version, m.name, new Date().toISOString()],
      },
    ]);
    result.push({ version: m.version, name: m.name });
  }
  return result;
}

/**
 * The highest applied version, or 0 when nothing has been applied.
 *
 * Reported rather than judged: `preflight` (spec 027 §3.5) asks whether pending
 * migrations exist and states the answer.
 */
export async function schemaVersion(): Promise<number> {
  demand("db.read", SQL_RESOURCE, { attributes: { tables: [MIGRATIONS_TABLE] } });
  await ready;
  const rows = await hiqlite.query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1`,
    [MIGRATIONS_TABLE],
  );
  if (rows.length === 0) return 0;
  const max = await hiqlite.query(`SELECT MAX(version) AS v FROM ${MIGRATIONS_TABLE}`);
  return Number(max[0]?.v ?? 0);
}
