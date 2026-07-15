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

import type { LedgerDriver, LedgerTx, SqlRow, SqlValue } from "./driver";
import { LibsqlDriver } from "./libsql";
import type { EntityCtor } from "./metadata";
import { entityMeta } from "./metadata";
import { PostgresDriver } from "./postgres";
import { Repository } from "./repository";
import { ensureSchema } from "./schema";

function driverFromEnv(): LedgerDriver {
  const url = process.env.ENRAHITU_LEDGER_URL ?? "file:./.data/ledger/enrahitu.db";
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return new PostgresDriver({
      url,
      poolSize: process.env.ENRAHITU_LEDGER_POOL_SIZE
        ? Number(process.env.ENRAHITU_LEDGER_POOL_SIZE)
        : undefined,
    });
  }
  const syncUrl = process.env.ENRAHITU_LEDGER_SYNC_URL;
  return new LibsqlDriver({
    url,
    syncUrl: syncUrl || undefined,
    authToken: process.env.ENRAHITU_LEDGER_AUTH_TOKEN || undefined,
    syncIntervalSecs: process.env.ENRAHITU_LEDGER_SYNC_INTERVAL_SECS
      ? Number(process.env.ENRAHITU_LEDGER_SYNC_INTERVAL_SECS)
      : undefined,
  });
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
