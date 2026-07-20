/**
 * The CoreLedger adjudication seam (spec 021 §3.5, spec 003 §5): wraps
 * the env-selected driver before the Ledger facade sees it. The verb
 * mapping is mechanical (query/execute/batch/transaction to
 * db.read/db.write/db.migrate/db.txn on the declared database resource);
 * interactive transactions re-wrap the inner tx so nothing escapes the
 * seam. Semantic SQL classification and per-table attribution are named
 * v0.2 extensions.
 */
import type { LedgerDriver, LedgerTx } from "../core/ledger/driver";

import { demand } from "./adjudicate";

function governTx(tx: LedgerTx, resource: string): LedgerTx {
  return {
    query(sql, params) {
      demand("db.read", resource);
      return tx.query(sql, params);
    },
    execute(sql, params) {
      demand("db.write", resource);
      return tx.execute(sql, params);
    },
  };
}

export function governDriver(driver: LedgerDriver, resource: string): LedgerDriver {
  return {
    dialect: driver.dialect,
    query(sql, params) {
      demand("db.read", resource);
      return driver.query(sql, params);
    },
    execute(sql, params) {
      demand("db.write", resource);
      return driver.execute(sql, params);
    },
    batch(statements) {
      demand("db.migrate", resource);
      return driver.batch(statements);
    },
    transaction(fn) {
      demand("db.txn", resource);
      return driver.transaction((tx) => fn(governTx(tx, resource)));
    },
    close() {
      return driver.close();
    },
  };
}
