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

import { governDriver } from "../../kernel/governed-driver";
import { instrumentDriver } from "../../obs/instrument";

import type { LedgerDriver, LedgerTx, SqlRow, SqlValue } from "./driver";
import { rawDriverFromEnv } from "./from-env";
import type { EntityCtor } from "./metadata";
import { entityMeta } from "./metadata";
import { Repository } from "./repository";
import { ensureSchema } from "./schema";

// Every driver acquired through the facade is governed (spec 021 §3.5):
// the raw driver exists only behind this wrap and in the enforcement
// plane's own Decision store. Instrumentation wraps outermost (spec 022):
// operation spans and counters cover adjudication plus the operation.
function driverFromEnv(): LedgerDriver {
  return instrumentDriver(governDriver(rawDriverFromEnv(), "app"), "app");
}

export class Ledger {
  private readonly repos = new Map<EntityCtor, Repository<object>>();

  constructor(readonly driver: LedgerDriver) {}

  static fromEnv(): Ledger {
    return new Ledger(driverFromEnv());
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

let defaultLedger: Ledger | undefined;

/** The process-wide Ledger, configured from env on first use. */
export function ledger(): Ledger {
  defaultLedger ??= Ledger.fromEnv();
  return defaultLedger;
}
