/**
 * Raw driver selection from env (spec 003 §5): the URL scheme decides.
 * `postgres://` / `postgresql://` selects the Postgres driver; `file:` /
 * `libsql://` selects libSQL (the default, spec 003).
 *
 * The returned driver is UNGOVERNED. App code reaches it only through the
 * Ledger facade, which wraps it in the spec 021 governed proxy; the only
 * other permitted constructor site is the enforcement plane's own
 * Decision store (the extraction ban-list enforces both).
 */
import type { LedgerDriver } from "./driver";
import { LibsqlDriver } from "./libsql";
import { PostgresDriver } from "./postgres";

export function rawDriverFromEnv(): LedgerDriver {
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
