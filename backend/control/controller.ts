/**
 * Controllers (spec 034 §3.5): leased, fenced, watermarked reconcile loops.
 *
 * ## The ten-second lease is the shape of this file
 *
 * hiqlite hardcodes `LOCK_VALID_SECONDS = 10` with no configuration path (spec
 * 032 §3.4), so a pass that runs longer than ten seconds loses its lease WHILE
 * STILL RUNNING, and its replacement starts concurrently. Every structural
 * choice here follows from refusing to pretend otherwise:
 *
 * - A pass takes a budget well under the TTL and stops at the deadline, mid
 *   batch if necessary, rather than finishing what it started.
 * - Every write a reconciler makes carries the pass's fencing token, so a
 *   zombie that overran anyway is rejected by the store rather than by luck.
 * - The watermark is durable, so a pass that stops early simply resumes.
 *
 * ## Reconcilers must be idempotent, and the loop does not pretend to help
 *
 * The watermark advances once per batch, not once per item, so a crash mid
 * batch replays that batch. Advancing per item would cost a write per change
 * and still not give exactly-once, because the reconcile and the watermark
 * write are two operations in different transactions. Idempotence is cheaper
 * and it is required anyway: hiqlite replays cache events after a restart, so a
 * reconciler that cannot tolerate seeing a change twice is already broken
 * (spec 032 §3.5).
 *
 * ## The loop waits for its schema instead of failing into it
 *
 * Migration is a deploy step, not a boot step (spec 032 §3.6), so a fresh cell
 * runs with no `controller_watermark` until an operator applies it. That is a
 * precondition, and the loop treats it as one: it says so once and waits, rather
 * than failing a pass per tick at whatever the reconcile cadence happens to be.
 */
import { logError, logInfo, logWarn } from "../lib/logger";
import { execute, query, withLease } from "../state";

import { changesSince, waker, type Change } from "./watch";
import { awaitControlSchema, WATERMARK_TABLE } from "./schema";

export interface ReconcileContext {
  /** The pass's fencing token. Pass it to every `admit`/`retract` (spec 032 §3.4). */
  readonly fence: number;
  /** Milliseconds left in this pass's budget. A long reconcile should check it. */
  remainingMs(): number;
}

export interface ControllerSpec {
  /** Stable identity: the lease key and the watermark row both derive from it. */
  name: string;
  /** Kinds to reconcile. Empty means every kind. */
  kinds?: string[];
  reconcile(change: Change, ctx: ReconcileContext): Promise<void>;
  /** Changes per scan. Default 100. */
  batchSize?: number;
  /** Idle wait between passes when nothing arrives. Default 1000ms. */
  tickMs?: number;
  /**
   * Wall-clock budget for one leased pass. Default 7000ms.
   *
   * Deliberately well under the ten-second TTL rather than close to it: the
   * budget is checked between reconciles, so the last one starts inside the
   * budget and finishes outside it. Three seconds of headroom is the allowance
   * for that overrun, and a reconciler that can exceed three seconds should be
   * consulting `remainingMs()`.
   */
  passBudgetMs?: number;
}

export interface RunningController {
  /** Stop after the pass in flight. Resolves once the loop has exited. */
  stop(): Promise<void>;
  /** The last revision this controller durably recorded as processed. */
  watermark(): number;
}

async function readWatermark(name: string): Promise<number> {
  const rows = await query<{ revision: number }>(
    `SELECT revision FROM ${WATERMARK_TABLE} WHERE controller = $1`,
    [name],
    { tables: [WATERMARK_TABLE] },
  );
  return rows.length > 0 ? Number(rows[0]!.revision) : 0;
}

async function writeWatermark(name: string, revision: number): Promise<void> {
  await execute(
    `INSERT INTO ${WATERMARK_TABLE} (controller, revision, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (controller) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at
      WHERE ${WATERMARK_TABLE}.revision < excluded.revision`,
    [name, revision, new Date().toISOString()],
    { tables: [WATERMARK_TABLE] },
  );
}

/**
 * Start a controller. Returns immediately; the loop runs until `stop()`.
 *
 * Failures inside a pass are logged and the loop continues: a controller that
 * exits on the first error is a controller that is down after the first
 * transient, and everything it reconciles is already expressed as
 * converge-toward-desired rather than apply-once.
 */
export function startController(spec: ControllerSpec): RunningController {
  const {
    name,
    kinds = [],
    batchSize = 100,
    tickMs = 1000,
    passBudgetMs = 7000,
  } = spec;

  let stopped = false;
  let mark = 0;
  const wake = waker({ kinds, tickMs });

  // The watermark table is this loop's own precondition, so the wait belongs
  // here rather than in each caller: a controller that reads
  // `controller_watermark` before it exists is wrong the same way whichever
  // service started it, and gating it once makes the next controller correct
  // without its author having to know that.
  const schemaWait = awaitControlSchema({
    onWaiting: () =>
      logInfo("controller: waiting for the control plane schema", {
        controller: name,
        detail: "passes begin once an operator applies the migration",
      }),
    onProbeError: (err) =>
      logWarn("controller: cannot tell whether the schema exists", {
        controller: name,
        error: String(err),
      }),
  });

  async function pass(): Promise<void> {
    await withLease(`ctl:${name}`, async (fence) => {
      const deadline = Date.now() + passBudgetMs;
      const ctx: ReconcileContext = {
        fence,
        remainingMs: () => Math.max(0, deadline - Date.now()),
      };
      mark = await readWatermark(name);

      while (Date.now() < deadline) {
        const batch = await changesSince(mark, { kinds, batchSize });
        if (batch.length === 0) return;

        let processed = 0;
        for (const change of batch) {
          if (Date.now() >= deadline) break;
          await spec.reconcile(change, ctx);
          processed = change.resource.revision;
        }
        if (processed === 0) return; // deadline hit before the first reconcile
        mark = processed;
        await writeWatermark(name, processed);
      }
    });
  }

  const loop = (async () => {
    logInfo("controller: started", { controller: name, kinds: kinds.join(",") || "*" });
    if (await schemaWait.done) {
      // `do`, not `while`: one pass runs once the gate opens even if `stop()`
      // was already requested. That is `runOnce`'s entire mechanism, and before
      // the gate existed it came for free from this loop's synchronous prefix,
      // which used to reach the first `pass()` before `startController` had even
      // returned to its caller. Awaiting the schema yields first, so the
      // guarantee has to be written down instead of inherited from scheduling.
      do {
        try {
          await pass();
        } catch (err) {
          // A lost lease is expected contention, not a fault: another node holds
          // it, and this pass simply did not happen.
          logWarn("controller: pass failed", { controller: name, error: String(err) });
        }
        if (stopped) break;
        await wake.next();
      } while (!stopped);
    }
    logInfo("controller: stopped", { controller: name, watermark: mark });
  })();

  loop.catch((err: unknown) => {
    logError("controller: loop escaped", { controller: name, error: String(err) });
  });

  return {
    async stop(): Promise<void> {
      stopped = true;
      schemaWait.cancel();
      wake.stop();
      await loop;
    },
    watermark: () => mark,
  };
}

/**
 * Run one pass and return, for tests and for a one-shot reconcile in an
 * operational verb (spec 027). Same leasing, fencing, and watermark as the
 * loop; it simply does not repeat.
 *
 * On a store whose schema has not been applied it returns 0 without running a
 * pass, rather than waiting for a migration that a one-shot call has no reason
 * to expect to arrive.
 */
export async function runOnce(spec: ControllerSpec): Promise<number> {
  const running = startController({ ...spec, tickMs: 1 });
  // The loop runs its first pass immediately; stop() waits for it to finish.
  await running.stop();
  return running.watermark();
}
