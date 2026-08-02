/**
 * Bringing the domain up (spec 036 §3.2, §3.6).
 *
 * Four steps, in an order that is load bearing: wait for the schema, refuse to
 * serve a foreign dataset, ensure the association's own record exists, and only
 * then start the loops.
 *
 * The wait comes first because this deployment may not have had its schema
 * applied yet (spec 036 §3.6), and every step after it reads a table. Waiting is
 * not the same as failing quietly: it logs once, on entry, and the endpoints
 * answer 503 naming the precondition in the meantime.
 */
import { runAsService } from "../kernel/adjudicate";
import { logError, logInfo } from "../lib/logger";
import { admit, get, startController, type RunningController } from "../control";
import { ready } from "../state";

import {
  renewalControllerSpec,
  startRenewalSweep,
  type RunningSweep,
} from "./controller";
import { registerMailKinds } from "../mail/notice";

import { TENANT, registerMembershipKinds, type TenantSpec } from "./kinds";
import { schemaPresent } from "./store";
import { TenantMismatchError, assertTenantConsistency, tenantId } from "./tenant";

const SERVICE = "members";
const SCHEMA_POLL_MS = 5000;

let controller: RunningController | undefined;
let sweep: RunningSweep | undefined;
let stopping = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSchema(): Promise<boolean> {
  if (await schemaPresent()) return true;
  logInfo("members: waiting for the control plane schema", {
    detail: "the membership surface answers 503 until an operator applies it",
  });
  while (!stopping) {
    await delay(SCHEMA_POLL_MS);
    if (await schemaPresent()) return true;
  }
  return false;
}

/**
 * Ensure the association has a record, without overwriting one.
 *
 * `admit` writes the spec it is given, so admitting unconditionally at every
 * boot would reset an operator's chosen display name back to the slug on every
 * restart: a change that reverts itself overnight and looks like somebody else
 * undid it. Ensure means create-if-absent, and nothing else.
 */
async function ensureOrgRecord(): Promise<void> {
  const tenant = tenantId();
  const existing = await get<TenantSpec>(TENANT, tenant);
  if (existing) return;
  await admit(TENANT, tenant, { displayName: tenant }, { actor: `boot:${SERVICE}` });
  logInfo("members: created the association record", { tenant });
}

/**
 * Start the domain. Returns once the loops are running, or once the wait for the
 * schema was interrupted by shutdown.
 *
 * Everything inside runs under this service's own kernel attribution. Module
 * evaluation has no request context, so without the scope the adjudication would
 * see the empty service and deny it, which is the correct default and the reason
 * the scope is explicit here (spec 021).
 */
export async function startMembershipRuntime(opts: { sweepIntervalMs?: number } = {}): Promise<void> {
  registerMembershipKinds();
  // The renewal controller raises mail notices (spec 036 §3.7, spec 037), and a
  // kind must be registered before it can be admitted. Registration is
  // idempotent for an identical definition (spec 034 §3.2), so doing it from
  // both services removes the boot-order hazard rather than creating one: which
  // service loads first is not something either of them should have to know.
  registerMailKinds();
  await ready;

  return runAsService(SERVICE, async () => {
    if (!(await waitForSchema())) return;

    // Before anything is written, and fatal by design (spec 036 §3.2).
    await assertTenantConsistency();
    await ensureOrgRecord();

    controller = startController(renewalControllerSpec());
    sweep = startRenewalSweep(
      opts.sweepIntervalMs === undefined ? {} : { intervalMs: opts.sweepIntervalMs },
    );
    logInfo("members: runtime started", { tenant: tenantId() });
  });
}

/** Stop both loops. Used by tests and by a graceful shutdown. */
export async function stopMembershipRuntime(): Promise<void> {
  stopping = true;
  await Promise.all([controller?.stop(), sweep?.stop()]);
  controller = undefined;
  sweep = undefined;
  stopping = false;
}

/**
 * Fire-and-forget entry point for service load.
 *
 * Exactly one failure stops the process, and the distinction is the whole point
 * of this function. A tenant mismatch means serving would write a second,
 * invisible dataset alongside the real one: silent, compounding, and worse the
 * longer it runs, so the process exits.
 *
 * **Everything else leaves the app up.** The first version of this exited on any
 * error and was wrong within a minute of meeting a real container: hiqlite
 * refused to open a volume left locked by an unclean shutdown, and a domain that
 * could not start took down `/healthz`, the admin dashboard, and the login flow
 * with it. Those are precisely what an operator needs in order to diagnose a
 * store that will not open. The domain stays down, its endpoints answer 503
 * naming the reason (§3.6), and the rest of the application keeps serving.
 */
export function startMembershipRuntimeOrExit(): void {
  startMembershipRuntime().catch((err: unknown) => {
    if (err instanceof TenantMismatchError) {
      logError("members: refusing to serve a foreign dataset", { error: err.message });
      if (!process.env.VITEST) process.exit(1);
      return;
    }
    logError("members: runtime did not start; the membership surface will answer 503", {
      error: String(err),
    });
  });
}
