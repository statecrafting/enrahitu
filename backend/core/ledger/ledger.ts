/**
 * The Ledger facade: driver selection from env, repositories, schema boot.
 *
 * Driver selection is config, not code: the URL scheme decides (spec 011).
 * `postgres://` / `postgresql://` selects the Postgres driver (the control
 * plane); `file:` / `libsql://` selects libSQL (the default, spec 003).
 *
 * Env knobs:
 * - `ENRAHITU_LEDGER_URL`                default `file:./.data/ledger/enrahitu.db`
 * - `ENRAHITU_LEDGER_SYNC_URL`           set to a `libsql://...turso.io` URL to
 *                                      turn the local file into a Turso
 *                                      embedded replica (libSQL only)
 * - `ENRAHITU_LEDGER_AUTH_TOKEN`         Turso auth token (libSQL only)
 * - `ENRAHITU_LEDGER_SYNC_INTERVAL_SECS` background sync cadence (libSQL only)
 * - `ENRAHITU_LEDGER_POOL_SIZE`          Postgres pool max (default 10)
 */

import { demand } from "../../kernel/adjudicate";
import { governDriver } from "../../kernel/governed-driver";
import { instrumentDriver } from "../../obs/instrument";

import type { LedgerDriver, LedgerTx, SqlRow, SqlValue } from "./driver";
import { rawDriverFromEnv } from "./from-env";
import type { EntityCtor } from "./metadata";
import { entityMeta } from "./metadata";
import { CORE_LEDGER_MIGRATIONS } from "./migration-list";
import {
  MIGRATIONS_TABLE,
  appliedVersions,
  migrate as runMigrations,
  type Migration,
} from "./migrations";
import { Repository } from "./repository";
import { ensureSchema, quoteIdent } from "./schema";

// Every driver acquired through the facade is governed (spec 021 §3.5):
// the raw driver exists only behind this wrap and in the enforcement
// plane's own Decision store. Instrumentation wraps outermost (spec 022):
// operation spans and counters cover adjudication plus the operation.
// `Ledger.fromEnv()` builds that stack and keeps the raw driver beside it for
// the migration seam alone; see `Ledger.migrate`.

/** What one `migrate` call did, and where the ledger stands after it. */
export interface LedgerMigrateResult {
  /**
   * Versions recorded during this call, ascending. Where `concurrent` is set
   * this is what became recorded while the call ran, which may include another
   * runner's work: two runners racing cannot attribute a row between them, and
   * claiming otherwise would be the one part of this report that is a guess.
   */
  applied: number[];
  /** The highest applied version after the call. */
  version: number;
  /**
   * Set when another runner applied a version this one was running against.
   * Not an error: the ledger is consistent, every declared migration is
   * recorded, and the caller is told that rather than handed the error the
   * collision produced.
   */
  concurrent?: string;
}

export class Ledger {
  private readonly repos = new Map<EntityCtor, Repository<object>>();

  /**
   * `driver` is governed and instrumented and is what everything reaches;
   * `raw` is the same connection before either wrap, and exists only for the
   * migration seam below. Both default to the one driver a test constructs,
   * so `new Ledger(fake)` is unchanged.
   */
  constructor(
    readonly driver: LedgerDriver,
    private readonly raw: LedgerDriver = driver,
  ) {}

  static fromEnv(): Ledger {
    const raw = rawDriverFromEnv();
    return new Ledger(instrumentDriver(governDriver(raw, "app"), "app"), raw);
  }

  /** Create tables/indexes for the given (default: all) registered entities. */
  async init(entities?: EntityCtor[]): Promise<void> {
    await ensureSchema(this.driver, entities);
  }

  repo<T extends object>(ctor: EntityCtor<T>): Repository<T> {
    let repo = this.repos.get(ctor as EntityCtor);
    if (!repo) {
      repo = new Repository<object>(this.driver, entityMeta(ctor), ctor as EntityCtor);
      this.repos.set(ctor as EntityCtor, repo);
    }
    return repo as Repository<T>;
  }

  /** Repositories bound to one interactive transaction. */
  async transaction<T>(
    fn: (repos: { repo<E extends object>(ctor: EntityCtor<E>): Repository<E>; tx: LedgerTx }) => Promise<T>,
  ): Promise<T> {
    return this.driver.transaction((tx) =>
      fn({
        repo: <E extends object>(ctor: EntityCtor<E>) =>
          new Repository<E>(tx, entityMeta(ctor), ctor),
        tx,
      }),
    );
  }

  /**
   * Apply every pending migration, as one adjudicated act (spec 027 §3.4).
   *
   * Adjudicated once, as one `db.migrate` effect on `app`, then executed
   * against the driver before the governance wrap. The reason is the one spec
   * 032 §3.6 already gave for the state layer's half, and it holds here for the
   * same reason it held there: the runner's internal read of applied versions
   * and its per-migration transaction are the MECHANISM of the effect the
   * caller asked for, not further effects the caller chose. Re-adjudicating
   * each would report several Decisions for one act and would make `db.migrate`
   * unusable on its own, since a service could not migrate without also holding
   * `db.read`, `db.write` and `db.txn` on the whole ledger. A grant that wide
   * is not a migration grant; it is write access with a migration-shaped name.
   *
   * The seam lives here and nowhere else, because this file is already the one
   * place outside the enforcement plane's Decision store that may hold an
   * ungoverned driver (spec 021 §3.5). It reaches the same connection the
   * facade governs rather than opening a second one.
   *
   * **It is a deploy step, not a boot step** (spec 027 §3.4). The operator
   * plane is its transport: `POST /api/admin/ledger/schema/apply`.
   */
  async migrate(migrations: Migration[] = CORE_LEDGER_MIGRATIONS): Promise<LedgerMigrateResult> {
    demand("db.migrate", "app");
    const before = new Set(await appliedVersions(this.raw));
    try {
      const applied = await runMigrations(this.raw, migrations);
      return { applied, version: await this.readSchemaVersion(this.raw) };
    } catch (err) {
      // The concurrent loser, decided on a fact rather than on the shape of an
      // error message. §3.4 expected that loser to fail at the recording
      // insert, on the migrations table's primary key. It usually does not:
      // it fails inside its own `up()`, because the winner already created the
      // table the migration creates, and that error looks nothing like a
      // constraint violation. Matching error text would therefore have caught
      // the case the spec imagined and missed the case that happens.
      //
      // So the question asked is whether every declared version is now
      // recorded. If it is, the failure was caused by work another runner had
      // already done, and nothing is half-applied: each migration shares its
      // transaction with its recording insert, so the loser rolled back whole.
      // If any version is still missing, this was a real failure and it is
      // rethrown exactly as it arrived (spec 027 §4 item 7).
      const after = new Set(await appliedVersions(this.raw));
      if (!migrations.every((m) => after.has(m.version))) throw err;
      const version = await this.readSchemaVersion(this.raw);
      return {
        applied: [...after].filter((v) => !before.has(v)).sort((a, b) => a - b),
        version,
        concurrent:
          `another runner applied a migration while this one was running; ` +
          `every declared version is recorded, the ledger is at version ${version}, ` +
          `and nothing was left half-applied.`,
      };
    }
  }

  /**
   * The highest applied migration version, or 0 when nothing has been applied.
   *
   * Reads through the governed driver, so it adjudicates as `db.read` and keeps
   * its span, and reads only: `appliedVersions()` would create the migrations
   * table on the way past, which would make a report a write.
   */
  async schemaVersion(): Promise<number> {
    return this.readSchemaVersion(this.driver);
  }

  private async readSchemaVersion(driver: LedgerDriver): Promise<number> {
    try {
      const rows = await driver.query(
        `SELECT MAX(${quoteIdent("version")}) AS v FROM ${quoteIdent(MIGRATIONS_TABLE)}`,
      );
      return Number(rows[0]?.v ?? 0);
    } catch (err) {
      // No table is a state, not a failure: nothing has been applied.
      if (isMissingTable(err)) return 0;
      throw err;
    }
  }

  /** Raw escape hatches; prefer repositories for entity access. */
  query(sql: string, params?: SqlValue[]): Promise<SqlRow[]> {
    return this.driver.query(sql, params);
  }

  execute(sql: string, params?: SqlValue[]): Promise<{ rowsAffected: number }> {
    return this.driver.execute(sql, params);
  }

  close(): Promise<void> {
    return this.driver.close();
  }
}

/**
 * "The table is not there", in the two dialects' own words.
 *
 * The only error this file classifies by shape, and it is safe to: a missing
 * migrations table is a state (nothing applied) rather than a failure, and
 * misreading a different error as that state costs a `0` where an exception
 * belonged, in a read-only report. Every other decision here is made on a fact
 * read back from the ledger, for the reason `migrate` gives above.
 */
function isMissingTable(err: unknown): boolean {
  const e = err as { message?: unknown; code?: unknown; cause?: unknown };
  const own = typeof e?.message === "string" ? e.message : "";
  const cause = e?.cause as { message?: unknown } | undefined;
  const message = `${own} ${typeof cause?.message === "string" ? cause.message : ""}`;
  const code = typeof e?.code === "string" ? e.code : "";
  return (
    code === "42P01" || /no such table/i.test(message) || /relation .* does not exist/i.test(message)
  );
}

let defaultLedger: Ledger | undefined;

/** The process-wide Ledger, configured from env on first use. */
export function ledger(): Ledger {
  defaultLedger ??= Ledger.fromEnv();
  return defaultLedger;
}
