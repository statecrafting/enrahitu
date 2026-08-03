/**
 * The renewal controller (spec 036 §3.7): two loops over one rule.
 *
 * ## Why two loops
 *
 * A change feed cannot observe the passage of time. Spec 034's watch answers
 * "what has been written since revision N", and a membership whose term expires
 * tomorrow is not written tomorrow: nothing happens, which is exactly the event
 * the renewal rule cares about. A purely change-driven controller would lapse
 * nobody until somebody happened to edit their row.
 *
 * So the change loop reacts to writes (a payment recorded now renews the
 * membership within a tick) and the sweep reacts to the calendar (an expiry
 * today is seen today). This is the resync interval every real controller ends
 * up with, arrived at from the same direction.
 *
 * ## Why they share one lease key
 *
 * Both write the same rows, and the fencing token is monotonic per key (spec 032
 * §3.4). Sharing `ctl:renewal` therefore buys two properties at once: the loops
 * never run concurrently, and whichever acquires later necessarily holds the
 * higher token, so neither can be refused as superseded by the other. Two keys
 * would produce interleaved tokens and a steady trickle of spurious
 * `SupersededError`s that mean nothing.
 */
import { logInfo, logWarn } from "../lib/logger";
import { admit, get, list, setStatus, type Change, type ControllerSpec } from "../control";
import { withLease } from "../state";

import { raiseNotice } from "../mail/notice";

import { today } from "./dates";
import {
  DUES_INVOICE,
  MEMBER,
  MEMBERSHIP,
  TENANT,
  TIER,
  type DuesInvoiceSpec,
  type InvoiceStatus,
  type MemberSpec,
  type MembershipSpec,
  type TenantSpec,
  type TierSpec,
} from "./kinds";
import { evaluate, invoiceNameFor, type NoticeIntent } from "./renewal";

export const RENEWAL_CONTROLLER = "renewal";

/** The key `startController` derives from the controller name, shared by the sweep. */
export const RENEWAL_LEASE = `ctl:${RENEWAL_CONTROLLER}`;

const ACTOR = `controller:${RENEWAL_CONTROLLER}`;

/**
 * Converge one membership.
 *
 * The tenant is a parameter and is threaded into every read and write, because
 * the change feed carries no tenant predicate (spec 036 §3.2): `changesSince`
 * hands this function rows from every tenant and nothing structural stops a
 * reconciler from resolving a tier in the wrong one. This signature is the only
 * thing holding that line, which is why it takes the tenant first.
 */
export async function reconcileMembership(
  tenant: string,
  name: string,
  fence: number,
  day: string,
): Promise<void> {
  const membership = await get<MembershipSpec>(MEMBERSHIP, name, { tenant });
  if (!membership) return;

  const tier = await get<TierSpec>(TIER, membership.spec.tier, { tenant });
  const endsOn = membership.spec.endsOn;
  const invoiceName = endsOn ? invoiceNameFor(name, endsOn) : undefined;
  const invoice = invoiceName
    ? await get<DuesInvoiceSpec>(DUES_INVOICE, invoiceName, { tenant })
    : null;

  const plan = evaluate({
    membershipName: name,
    membership: membership.spec,
    tier: tier?.spec ?? null,
    invoice: invoice
      ? { spec: invoice.spec, status: (invoice.status as InvoiceStatus | null) ?? null }
      : null,
    today: day,
  });

  // The invoice carries no fencing token deliberately. The controller is the
  // only writer of an invoice's spec and the write is idempotent by name, so
  // there is no zombie to fence out; and leaving the mark at zero is what lets a
  // treasurer record payment on it later without having to hold a lease.
  if (plan.invoice) {
    await admit(DUES_INVOICE, plan.invoice.name, plan.invoice.spec, { tenant, actor: ACTOR });
  }

  // Extending the term is a SPEC write, so it follows the human plane's rule and
  // passes the fence it read (spec 036 §3.4) rather than the pass token: a
  // controller that raised the mark here would lock operators out of the row it
  // just renewed.
  if (plan.renewTo) {
    await admit(MEMBERSHIP, name, plan.renewTo, {
      tenant,
      fence: membership.fence,
      actor: ACTOR,
    });
  }

  if (plan.notice) {
    await raiseDuesNotice(tenant, plan.notice, membership.spec, tier!.spec);
  }

  await setStatus(MEMBERSHIP, name, plan.status, { tenant, fence, actor: ACTOR });
}

function money(cents: number): string {
  return `${(cents / 100).toFixed(2)}`;
}

/**
 * Resolve a notice's recipient and wording data, then raise it (spec 037).
 *
 * Raising is idempotent by name, so this runs on every reconcile that plans a
 * notice and produces one resource. Nothing here awaits a relay: the notice is
 * admitted and the mail controller delivers it, which is what keeps a reconcile
 * pass free of the one operation that can block for thirty seconds.
 *
 * A failure to raise is swallowed deliberately. Dues are the thing that must
 * converge; a notice is a courtesy on top of it, and a mail subsystem that is
 * misconfigured must not stop a membership from lapsing or renewing correctly.
 */
async function raiseDuesNotice(
  tenant: string,
  intent: NoticeIntent,
  membership: MembershipSpec,
  tier: TierSpec,
): Promise<void> {
  try {
    const invoice = await get<DuesInvoiceSpec>(DUES_INVOICE, intent.invoice, { tenant });
    if (!invoice) return;
    const member = await get<MemberSpec>(MEMBER, membership.member, { tenant });
    // No address, no notice. A member record without an email is legitimate
    // (an association may hold a postal-only member), so this is a skip rather
    // than an error.
    if (!member?.spec.email) return;

    const org = await get<TenantSpec>(TENANT, tenant);
    const orgName = org?.spec.displayName ?? tenant;
    const status = invoice.status as InvoiceStatus | null;

    const params: Record<string, string> =
      intent.template === "dues-reminder"
        ? {
            memberName: member.spec.displayName,
            tierLabel: tier.label,
            orgName,
            amount: money(invoice.spec.amountCents),
            periodStart: invoice.spec.periodStart,
            dueOn: invoice.spec.dueOn,
          }
        : {
            memberName: member.spec.displayName,
            tierLabel: tier.label,
            orgName,
            amount: money(invoice.spec.amountCents),
            paidOn: status?.paidOn ?? invoice.spec.periodStart,
            renewsOn: invoice.spec.periodEnd,
          };

    const subject =
      intent.template === "dues-reminder"
        ? `${orgName}: your membership dues are due ${invoice.spec.dueOn}`
        : `${orgName}: receipt for your membership dues`;

    await raiseNotice(
      tenant,
      intent.template,
      intent.invoice,
      { to: member.spec.email, template: intent.template, params, subject },
      { actor: ACTOR },
    );
  } catch (err) {
    logWarn("renewal: could not raise the dues notice", {
      tenant,
      invoice: intent.invoice,
      template: intent.template,
      error: String(err),
    });
  }
}

/** The membership a change concerns, or null when the change needs no reconcile. */
function subjectOf(change: Change): { tenant: string; membership: string } | null {
  const { kind, tenant, name, spec } = change.resource;
  if (kind === MEMBERSHIP) {
    // A retracted membership has nothing left to converge toward.
    return change.retracted ? null : { tenant, membership: name };
  }
  if (kind === DUES_INVOICE) {
    // A retracted invoice DOES reconcile its membership: what it owes changed.
    return { tenant, membership: (spec as DuesInvoiceSpec).membership };
  }
  return null;
}

/** The change-driven half, for `startController` (spec 034 §3.5). */
export function renewalControllerSpec(): ControllerSpec {
  return {
    name: RENEWAL_CONTROLLER,
    kinds: [MEMBERSHIP, DUES_INVOICE],
    async reconcile(change, ctx) {
      const subject = subjectOf(change);
      if (!subject) return;
      await reconcileMembership(subject.tenant, subject.membership, ctx.fence, today());
    },
  };
}

export interface RunningSweep {
  stop(): Promise<void>;
  /** Memberships reconciled by the most recent sweep. Read by tests. */
  lastCount(): number;
}

/**
 * One calendar pass over every membership in every tenant.
 *
 * Bounded by the same kind of budget a controller pass uses, and for the same
 * reason: the lease expires in ten seconds whether or not the holder is
 * finished (spec 032 §3.4). Stopping early is free here because the sweep keeps
 * no watermark and re-lists from the top next time.
 */
export async function sweepOnce(budgetMs = 7000): Promise<number> {
  return withLease(RENEWAL_LEASE, async (fence) => {
    const deadline = Date.now() + budgetMs;
    const day = today();
    let reconciled = 0;

    for (const tenant of await list<TenantSpec>(TENANT)) {
      if (Date.now() >= deadline) break;
      for (const membership of await list<MembershipSpec>(MEMBERSHIP, { tenant: tenant.name })) {
        if (Date.now() >= deadline) break;
        try {
          await reconcileMembership(tenant.name, membership.name, fence, day);
          reconciled++;
        } catch (err) {
          // One membership that cannot be reconciled must not stop the pass.
          // The enumeration is ordered, so an exception here would silently drop
          // every membership after this one: a single malformed row would leave
          // the rest of the association unbilled, every hour, indefinitely, and
          // the only symptom would be dues that never appear. Skipping is safe
          // because the sweep keeps no watermark and re-lists from the top, so
          // the next pass tries this row again.
          logWarn("renewal sweep: membership did not reconcile", {
            tenant: tenant.name,
            membership: membership.name,
            error: String(err),
          });
        }
      }
    }
    return reconciled;
  });
}

/**
 * Start the calendar loop.
 *
 * Hourly by default. The rule's inputs change at most once a day, so a shorter
 * interval buys nothing an operator would notice, and a longer one delays a
 * lapse past the day it happens.
 */
export function startRenewalSweep(opts: { intervalMs?: number } = {}): RunningSweep {
  const intervalMs = opts.intervalMs ?? 3_600_000;
  let stopped = false;
  let count = 0;
  let wake: (() => void) | undefined;

  const idle = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(finish, intervalMs);
      function finish(): void {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      }
      wake = finish;
    });

  const loop = (async () => {
    logInfo("renewal sweep: started", { intervalMs });
    while (!stopped) {
      try {
        count = await sweepOnce();
      } catch (err) {
        // Losing the lease to the change loop is ordinary contention, not a
        // fault: this sweep simply did not happen, and the next one will.
        logWarn("renewal sweep: pass failed", { error: String(err) });
      }
      if (stopped) break;
      await idle();
    }
    logInfo("renewal sweep: stopped", {});
  })();

  loop.catch((err: unknown) => {
    logWarn("renewal sweep: loop escaped", { error: String(err) });
  });

  return {
    async stop(): Promise<void> {
      stopped = true;
      wake?.();
      await loop;
    },
    lastCount: () => count,
  };
}
