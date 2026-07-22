/**
 * CoreLedger operation instrumentation (spec 022 §3.1-3.2): wraps the
 * governed driver outermost (spec 003 §5 seam order: instrument around
 * govern around raw), so spans cover adjudication plus the operation and a
 * kernel deny surfaces as an errored child span. Counters always move;
 * spans are created only under an active parent so boot-time schema work
 * does not fill the trace buffer with rootless noise.
 */
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { LedgerDriver, LedgerTx } from "../core/ledger/driver";

import { coreledgerOperationsTotal } from "./metrics";
import { tracer } from "./tracer";

function observeOp<T>(operation: string, resource: string, run: () => Promise<T>): Promise<T> {
  coreledgerOperationsTotal.inc({ operation, resource });
  if (trace.getActiveSpan() === undefined) return run();
  return tracer.startActiveSpan(
    `coreledger.${operation}`,
    {
      kind: SpanKind.CLIENT,
      attributes: { "enrahitu.coreledger.operation": operation, "enrahitu.coreledger.resource": resource },
    },
    async (span) => {
      try {
        return await run();
      } catch (err) {
        if (err instanceof Error) span.recordException(err);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

function instrumentTx(tx: LedgerTx, resource: string): LedgerTx {
  return {
    query(sql, params) {
      return observeOp("read", resource, () => tx.query(sql, params));
    },
    execute(sql, params) {
      return observeOp("write", resource, () => tx.execute(sql, params));
    },
  };
}

export function instrumentDriver(driver: LedgerDriver, resource: string): LedgerDriver {
  return {
    dialect: driver.dialect,
    query(sql, params) {
      return observeOp("read", resource, () => driver.query(sql, params));
    },
    execute(sql, params) {
      return observeOp("write", resource, () => driver.execute(sql, params));
    },
    batch(statements) {
      return observeOp("migrate", resource, () => driver.batch(statements));
    },
    transaction(fn) {
      return observeOp("txn", resource, () =>
        driver.transaction((tx) => fn(instrumentTx(tx, resource))),
      );
    },
    close() {
      return driver.close();
    },
  };
}
