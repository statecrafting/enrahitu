/**
 * The delivery controller (spec 037 §3.3).
 *
 * Delivery is reconciliation toward a state, not a call at the point the
 * decision is made. Nothing awaits a relay inside a request: an endpoint or a
 * domain controller admits a notice and returns, and this loop does the sending.
 * That is the research position that mail must not block a request, delivered
 * without a second piece of infrastructure. Redis and a job runner would buy
 * retry semantics the control plane already has, and would cost spec 001's one
 * container and one volume, which is the thesis the whole architecture is
 * organized around.
 *
 * **It is at-least-once and says so.** A crash between the SMTP handshake
 * completing and the status write sends one duplicate. That is the honest
 * guarantee, and it is exactly why the notice's NAME carries the dedupe rather
 * than the delivery: raising the same notice twice raises one resource, which is
 * the property that actually prevents a member receiving a hundred reminders.
 */
import { logInfo, logWarn } from "../lib/logger";
import {
  awaitControlSchema,
  get,
  list,
  setStatus,
  type Change,
  type ControllerSpec,
} from "../control";
import { withLease } from "../state";

import { MAIL_NOTICE, type MailNoticeSpec, type MailNoticeStatus } from "./kinds";
import { afterFailure, afterSuccess, planFor } from "./schedule";
import { renderTemplate } from "./templates";
import { type MailTransport } from "./transport";

export const MAIL_CONTROLLER = "mail";

/** The key `startController` derives from the controller name, shared by the sweep. */
export const MAIL_LEASE = `ctl:${MAIL_CONTROLLER}`;

const ACTOR = `controller:${MAIL_CONTROLLER}`;

/**
 * Deliver one notice, or record why not.
 *
 * The status write is the only thing this function is allowed to get wrong
 * twice: everything before it is either a pure render or a send that the name
 * already deduplicates.
 */
export async function deliverNotice(
  transport: MailTransport,
  tenant: string,
  name: string,
  fence: number,
  now = Date.now(),
): Promise<"sent" | "skipped" | "failed"> {
  const notice = await get<MailNoticeSpec>(MAIL_NOTICE, name, { tenant });
  if (!notice) return "skipped";

  const status = (notice.status as MailNoticeStatus | null) ?? null;
  const plan = planFor(status, now);
  if (!plan.attempt) return "skipped";

  try {
    const rendered = renderTemplate(notice.spec.template, notice.spec.params);
    await transport.send({
      to: notice.spec.to,
      subject: notice.spec.subject,
      text: rendered.text,
      html: rendered.html,
      ...((notice.spec as MailNoticeSpec & { replyTo?: string }).replyTo
        ? { replyTo: (notice.spec as MailNoticeSpec & { replyTo?: string }).replyTo }
        : {}),
    });
    await setStatus(MAIL_NOTICE, name, afterSuccess(status, now), { tenant, fence, actor: ACTOR });
    logInfo("mail: notice delivered", { tenant, notice: name, transport: transport.name });
    return "sent";
  } catch (err) {
    const next = afterFailure(status, String((err as Error)?.message ?? err), now);
    await setStatus(MAIL_NOTICE, name, next, { tenant, fence, actor: ACTOR });
    // Logged at warn even when it will be retried, because the first failure is
    // the one an operator can still act on. A notice that has given up is logged
    // the same way and then stays readable in the list, which is the surface that
    // actually answers "was this member told".
    logWarn("mail: notice not delivered", {
      tenant,
      notice: name,
      attempts: next.attempts,
      state: next.state,
      error: next.lastError ?? "",
    });
    return next.state === "failed" ? "failed" : "skipped";
  }
}

/** The change-driven half: a newly raised notice is delivered within a tick. */
export function mailControllerSpec(transport: MailTransport): ControllerSpec {
  return {
    name: MAIL_CONTROLLER,
    kinds: [MAIL_NOTICE],
    async reconcile(change: Change, ctx) {
      if (change.retracted) return;
      await deliverNotice(transport, change.resource.tenant, change.resource.name, ctx.fence);
    },
  };
}

export interface RunningMailSweep {
  stop(): Promise<void>;
  lastCount(): number;
}

/**
 * One pass over every notice still awaiting delivery.
 *
 * The change feed cannot deliver "this notice's backoff has now elapsed", for
 * exactly the reason spec 036 §3.7's calendar sweep exists: a deferred retry is
 * not a write. So retry is driven from here, and the schedule is a status rather
 * than a queue.
 *
 * It enumerates tenants from the notices themselves rather than from the tenant
 * registry, so the DELIVERY PATH carries no dependency on the membership
 * domain: mail is a channel, and the first thing to use it happens to be dues.
 *
 * The operator endpoint in `api.ts` does import the members service's tenant
 * seam and error vocabulary, because there is exactly one of each and a second
 * copy would be a second answer to "which association is this". That coupling
 * is at the edge only: nothing the controller, transport, schedule or template
 * resolver does can reach it, so a deployment that pruned the membership domain
 * would lose the notice list and keep the channel.
 */
export async function mailSweepOnce(
  transport: MailTransport,
  budgetMs = 7000,
): Promise<number> {
  return withLease(MAIL_LEASE, async (fence) => {
    const deadline = Date.now() + budgetMs;
    let delivered = 0;

    for (const tenant of await tenantsWithNotices()) {
      if (Date.now() >= deadline) break;
      for (const notice of await list<MailNoticeSpec>(MAIL_NOTICE, { tenant })) {
        if (Date.now() >= deadline) break;
        try {
          if ((await deliverNotice(transport, tenant, notice.name, fence)) === "sent") delivered++;
        } catch (err) {
          // One notice that cannot even record its own failure must not stop the
          // pass, for the same reason it must not in the renewal sweep (spec 036
          // §3.7): the enumeration is ordered, so throwing here would silently
          // strand every notice after this one.
          logWarn("mail: notice pass failed", { tenant, notice: notice.name, error: String(err) });
        }
      }
    }
    return delivered;
  });
}

/**
 * The tenants that have notices.
 *
 * `changesSince` carries no tenant predicate (spec 036 §3.2) and `list` needs
 * one, so the set has to come from somewhere. Reading it off the notices is the
 * answer that keeps this module free of the domain: a deployment with no
 * membership domain at all can still send mail.
 */
async function tenantsWithNotices(): Promise<string[]> {
  const { query } = await import("../state");
  const rows = await query<{ tenant: string }>(
    `SELECT DISTINCT tenant FROM resource WHERE kind = $1 AND deleted_at IS NULL`,
    [MAIL_NOTICE],
    { tables: ["resource"] },
  );
  return rows.map((r) => String(r.tenant));
}

/**
 * Start the retry loop.
 *
 * A minute by default. The shortest backoff is a minute, so a longer interval
 * would make the first retry late by up to the difference, and a shorter one
 * would spend passes discovering that nothing is due yet.
 *
 * Like the controller, it waits for the control plane's schema rather than
 * failing a pass into its absence. `startController` gates itself, but this loop
 * is not one: it scans `resource` on its own timer, so a fresh cell would have
 * had the same permanent error loop here at a minute's cadence instead of a
 * second's, which is quieter and no more correct.
 */
export function startMailSweep(
  transport: MailTransport,
  opts: { intervalMs?: number } = {},
): RunningMailSweep {
  const intervalMs = opts.intervalMs ?? 60_000;
  let stopped = false;
  let count = 0;
  let wake: (() => void) | undefined;

  const schemaWait = awaitControlSchema({
    onWaiting: () =>
      logInfo("mail sweep: waiting for the control plane schema", {
        detail: "notices are held as pending until an operator applies the migration",
      }),
    onProbeError: (err) =>
      logWarn("mail sweep: cannot tell whether the schema exists", { error: String(err) }),
  });

  const idle = (): Promise<void> =>
    new Promise<void>((resolvePromise) => {
      const timer = setTimeout(finish, intervalMs);
      function finish(): void {
        clearTimeout(timer);
        wake = undefined;
        resolvePromise();
      }
      wake = finish;
    });

  const loop = (async () => {
    logInfo("mail sweep: started", { intervalMs, transport: transport.name });
    if (await schemaWait.done) {
      while (!stopped) {
        try {
          count = await mailSweepOnce(transport);
        } catch (err) {
          logWarn("mail sweep: pass failed", { error: String(err) });
        }
        if (stopped) break;
        await idle();
      }
    }
    logInfo("mail sweep: stopped", {});
  })();

  loop.catch((err: unknown) => {
    logWarn("mail sweep: loop escaped", { error: String(err) });
  });

  return {
    async stop(): Promise<void> {
      stopped = true;
      schemaWait.cancel();
      wake?.();
      await loop;
    },
    lastCount: () => count,
  };
}
