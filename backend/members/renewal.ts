/**
 * The renewal rule (spec 036 §3.7): a pure function of the membership, its tier,
 * its current invoice, and today's date.
 *
 * It is separated from the controller that performs it, and not for testing
 * convenience. A renewal rule is a policy a board approves: when dues are
 * raised, how long the grace period runs, what lapses and when. A policy that
 * can only be read as a sequence of store calls cannot be reviewed by the people
 * whose policy it is. Everything below is readable top to bottom by someone who
 * has never seen this codebase, and the store never appears.
 *
 * The date arrives as an argument rather than being read from the clock, so
 * every branch is reachable in a test at the date that produces it.
 */
import { addDays, addPeriod } from "./dates";
import type {
  DuesInvoiceSpec,
  InvoiceStatus,
  MembershipSpec,
  MembershipStatus,
  TierSpec,
} from "./kinds";

export interface RenewalInput {
  membershipName: string;
  membership: MembershipSpec;
  /** Null when the membership names a tier that is not registered (spec 036 §3.3). */
  tier: TierSpec | null;
  /** The invoice for the term being billed, when one has already been raised. */
  invoice: { spec: DuesInvoiceSpec; status: InvoiceStatus | null } | null;
  today: string;
}

export interface RenewalPlan {
  /** An invoice to admit. Idempotent by name, so raising it twice raises one. */
  invoice?: { name: string; spec: DuesInvoiceSpec };
  /** A new membership term, when a paid invoice has renewed it. */
  renewTo?: MembershipSpec;
  /** Always present: every branch concludes in a status. */
  status: MembershipStatus;
}

/**
 * The invoice's name, and therefore its identity.
 *
 * Derived from the term being billed rather than from a counter or a clock,
 * which is what makes the whole loop idempotent: a controller that reconciles
 * the same membership a hundred times computes this same name a hundred times,
 * so the hundredth `admit` normalizes to the spec already stored and returns
 * without a revision (spec 034 §3.3). The controller keeps no record of what it
 * has raised and is correct after a crash, a replay, or a watermark reset.
 */
export function invoiceNameFor(membershipName: string, periodStart: string): string {
  return `${membershipName}-${periodStart}`;
}

export function evaluate(input: RenewalInput): RenewalPlan {
  const { membership, tier, invoice, today } = input;

  // Referential integrity is observed, not enforced (spec 036 §3.3). Retracting
  // a tier that memberships still use is a thing an operator may legitimately
  // do, and the right answer is to show what it broke.
  if (!tier) {
    return {
      status: { state: "invalid", problem: `tier '${membership.tier}' is not registered` },
    };
  }

  if (tier.period === "lifetime") {
    if (membership.endsOn) {
      return {
        status: {
          state: "invalid",
          problem: `tier '${membership.tier}' is lifetime, so this membership must not carry endsOn`,
        },
      };
    }
    return { status: { state: "active" } };
  }

  const endsOn = membership.endsOn;
  if (!endsOn) {
    return {
      status: {
        state: "invalid",
        problem: `tier '${membership.tier}' bills ${tier.period}, so this membership needs endsOn`,
      },
    };
  }

  if (today < endsOn) {
    return { status: { state: "active", renewsOn: endsOn } };
  }

  // The term is over.
  if (!membership.autoRenew) {
    return { status: { state: "lapsed", lapsedOn: endsOn } };
  }

  const periodEnd = addPeriod(endsOn, tier.period);
  const name = invoiceNameFor(input.membershipName, endsOn);

  if (!invoice) {
    return {
      invoice: {
        name,
        spec: {
          membership: input.membershipName,
          member: membership.member,
          tier: membership.tier,
          amountCents: tier.duesCents,
          periodStart: endsOn,
          periodEnd,
          dueOn: addDays(endsOn, tier.graceDays),
        },
      },
      status: { state: "pending", currentInvoice: name, renewsOn: periodEnd },
    };
  }

  const state = invoice.status?.state ?? "open";

  if (state === "paid") {
    // The loop that earns the control plane: a treasurer recorded a payment on
    // one resource, and a different resource renews without anything calling
    // anything.
    return {
      renewTo: { ...membership, startsOn: endsOn, endsOn: invoice.spec.periodEnd },
      status: { state: "active", renewsOn: invoice.spec.periodEnd },
    };
  }

  if (state === "void") {
    // Voiding dues is how an association declines to renew somebody without
    // pretending the invoice was paid.
    return { status: { state: "lapsed", lapsedOn: endsOn, currentInvoice: name } };
  }

  if (today > invoice.spec.dueOn) {
    return { status: { state: "lapsed", lapsedOn: invoice.spec.dueOn, currentInvoice: name } };
  }

  return { status: { state: "pending", currentInvoice: name, renewsOn: invoice.spec.periodEnd } };
}
