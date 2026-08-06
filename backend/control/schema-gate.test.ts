/**
 * The schema precondition (spec 034 §3.5), against a node whose migration has
 * never been applied.
 *
 * This file exists because the property under test is only visible BEFORE the
 * migration runs, and every other suite migrates in `beforeAll`. The state it
 * reproduces is not contrived: it is what a freshly provisioned cell is, from
 * first boot until an operator applies the schema, and it lasted forever at 1 Hz
 * of error log before this gate (spec 028's amendment, item 4).
 *
 * Nothing here migrates. A test that added the tables would answer a different
 * question.
 */
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { runAsService } from "../kernel/adjudicate";

/**
 * The defect is a log rate, so the log is what the test has to see. Hoisted
 * because `vi.mock` factories are lifted above every other statement in the
 * file, and the array has to exist by the time the factory runs.
 */
const { warnings } = vi.hoisted(() => ({ warnings: [] as string[] }));

vi.mock("../lib/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/logger")>();
  return {
    ...actual,
    logWarn(message: string, fields?: Record<string, unknown>): void {
      warnings.push(message);
      actual.logWarn(message, fields);
    },
  };
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let control: typeof import("./index");
let state: typeof import("../state");

beforeAll(async () => {
  const [raft, api] = await Promise.all([freePort(), freePort()]);
  process.env.ENRAHITU_HIQ_DATA_DIR = mkdtempSync(join(tmpdir(), "control-gate-"));
  process.env.ENRAHITU_HIQ_ADDR_RAFT = `127.0.0.1:${raft}`;
  process.env.ENRAHITU_HIQ_ADDR_API = `127.0.0.1:${api}`;
  control = await import("./index");
  state = await import("../state");
  await state.ready;
}, 60_000);

/** Every store crossing is adjudicated, so each one names the service making it. */
const asControl = <T>(fn: () => Promise<T>): Promise<T> => runAsService("control", fn);

describe("the control plane's schema precondition", () => {
  it("reports the tables as absent on a store nothing has migrated", async () => {
    await expect(asControl(() => control.controlSchemaPresent())).resolves.toBe(false);
  });

  /**
   * The defect this whole file is about. A controller used to call
   * `readWatermark` on its first pass, throw `no such table:
   * controller_watermark`, log it, sleep one tick, and repeat until the process
   * died.
   *
   * **The assertion is on the log, because the log IS the defect.** A first
   * draft of this test asserted that no reconcile ran and that the watermark
   * stayed at 0, and it passed against the unfixed code: the old loop threw at
   * `readWatermark`, several statements before anything a reconciler would see,
   * so both of those were equally true while it failed forty times a second.
   * They are kept as secondary assertions, and neither one is load bearing.
   */
  it("logs no repeated failure while the schema is absent", async () => {
    warnings.length = 0;
    let reconciles = 0;
    // `startController` returns synchronously, but its loop's continuations
    // inherit the scope in force when it was called, which is how both boot
    // paths attribute their controllers.
    const running = await asControl(async () =>
      control.startController({
        name: "gate-probe",
        tickMs: 5,
        reconcile: async () => {
          reconciles += 1;
        },
      }),
    );

    // Sixty ticks at this controller's cadence: the old loop failed a pass on
    // every one of them, so a single survivor here is the defect.
    await delay(300);
    expect(warnings.filter((m) => m === "controller: pass failed")).toEqual([]);
    expect(reconciles).toBe(0);
    expect(running.watermark()).toBe(0);

    await running.stop();
  }, 20_000);

  /**
   * A shutdown must not have to outlast the poll interval. The waiter is
   * cancellable precisely so `stop()` returns promptly instead of looking hung
   * for up to five seconds, which is the behavior a bare `setTimeout` loop would
   * have given.
   */
  it("stops promptly while waiting, rather than after a poll interval", async () => {
    const running = await asControl(async () =>
      control.startController({ name: "gate-stop", reconcile: async () => {} }),
    );
    await delay(50);

    const started = Date.now();
    await running.stop();
    expect(Date.now() - started).toBeLessThan(1000);
  }, 20_000);

  /**
   * `runOnce` has no reason to wait for a migration it cannot cause. It reports
   * the watermark it did not advance and returns.
   */
  it("returns 0 from runOnce rather than blocking on a schema that may never arrive", async () => {
    const started = Date.now();
    await expect(
      asControl(() => control.runOnce({ name: "gate-once", reconcile: async () => {} })),
    ).resolves.toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  }, 20_000);

  /**
   * The sweep is not a controller and so does not inherit `startController`'s
   * gate: it scans `resource` on its own timer and carries its own copy (spec
   * 037's amendment). It is tested here, against this file's un-migrated node,
   * rather than in the mail suite, whose node is migrated before any test runs.
   *
   * Both halves matter. The wait is the defect being fixed; the `cancel()` in
   * `stop()` is the one a reviewer would forget, and forgetting it hangs
   * `stopMailRuntime` rather than failing anything visible.
   */
  it("holds the mail sweep on the same precondition, and still stops", async () => {
    warnings.length = 0;
    const mail = await import("../mail/controller");
    const transport = {
      name: "test",
      async send(): Promise<void> {
        throw new Error("the sweep must not reach a transport with no schema");
      },
    };

    const sweep = await runAsService("mail", async () =>
      mail.startMailSweep(transport, { intervalMs: 5 }),
    );
    await delay(200);
    expect(warnings.filter((m) => m === "mail sweep: pass failed")).toEqual([]);
    expect(sweep.lastCount()).toBe(0);

    const started = Date.now();
    await sweep.stop();
    expect(Date.now() - started).toBeLessThan(1000);
  }, 20_000);

  /**
   * The other half: the gate must OPEN. A waiter that never proceeds would pass
   * every assertion above and leave the controller permanently silent, which is
   * a worse defect than the one being fixed.
   */
  it("proceeds once an operator applies the migration", async () => {
    const wait = await asControl(async () => control.awaitControlSchema({ pollMs: 25 }));
    let opened = false;
    void wait.done.then((ok) => {
      opened = ok;
    });

    await delay(100);
    expect(opened).toBe(false);

    await runAsService("state", () => state.migrate(control.CONTROL_PLANE_MIGRATIONS));

    await expect(wait.done).resolves.toBe(true);
    expect(await asControl(() => control.controlSchemaPresent())).toBe(true);
  }, 30_000);
});
