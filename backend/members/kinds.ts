/**
 * The membership core's five kinds (spec 036 §3.1).
 *
 * Every one is a runtime registration with no migration, which is the property
 * spec 035 §3.4 promised would make the chassis boundary cheap, spent here for
 * the first time: the association domain added zero DDL.
 *
 * `spec` is intent and `status` is observation, and they have different writers.
 * A person says what should be true (this member holds this tier until this
 * date); a controller says what is true (the term expired, the invoice is open).
 * Keeping them in separate columns is what lets a reconcile write its finding
 * without a read-modify-write against a value an operator may have changed
 * underneath it.
 *
 * `duesInvoice` inverts that: its spec is written by the controller, because an
 * invoice is derived from a membership and a tier rather than authored, and its
 * status is written by a person, because payment is a treasurer's entry. That
 * inversion is why spec 036 §3.4's fencing rule had to be worked out.
 */
import {
  InvalidSpecError,
  optionalString,
  registerKind,
  requireEnum,
  requireObject,
  requireString,
  type Kind,
} from "../control";

import { isDay } from "./dates";

export const TENANT = "tenant";
export const TIER = "tier";
export const MEMBER = "member";
export const MEMBERSHIP = "membership";
export const DUES_INVOICE = "duesInvoice";

export type BillingPeriod = "annual" | "monthly" | "lifetime";
export type MembershipState = "active" | "pending" | "lapsed" | "invalid";
export type InvoiceState = "open" | "paid" | "void";

export interface TenantSpec {
  displayName: string;
  contactEmail?: string;
}

export interface TierSpec {
  label: string;
  duesCents: number;
  period: BillingPeriod;
  votingRights: boolean;
  /** Days after a term ends before an unpaid membership lapses. */
  graceDays: number;
}

export interface MemberSpec {
  displayName: string;
  email: string;
  /** rauthy's subject claim: the join to identity (spec 001 §5.3). Optional, because a member may predate their login. */
  sub?: string;
  joinedOn: string;
}

export interface MembershipSpec {
  member: string;
  tier: string;
  startsOn: string;
  /** Absent for a lifetime tier, required otherwise. */
  endsOn?: string;
  autoRenew: boolean;
}

export interface DuesInvoiceSpec {
  membership: string;
  member: string;
  tier: string;
  amountCents: number;
  periodStart: string;
  periodEnd: string;
  dueOn: string;
}

/**
 * A membership's observed state.
 *
 * **It deliberately carries no evaluation timestamp.** An `evaluatedAt` would
 * differ on every pass, so every pass would be a write, every write a revision,
 * and every revision another reconcile: the quiescence rule (spec 034 §3.3) would
 * be defeated by the one field that looks like harmless bookkeeping. A status is
 * a function of the situation, not of when somebody looked at it.
 */
export interface MembershipStatus {
  state: MembershipState;
  /** The day the current term ends, when there is one. */
  renewsOn?: string;
  lapsedOn?: string;
  currentInvoice?: string;
  /** Set only for `invalid`: what is wrong, in words an operator can act on. */
  problem?: string;
}

export interface InvoiceStatus {
  state: InvoiceState;
  paidOn?: string;
  recordedBy?: string;
}

// ---------------------------------------------------------------------------
// Validator helpers
//
// Local to the domain rather than added to `backend/control/kinds.ts`: a
// calendar day is a domain shape here (spec 036 §3.7 terms are days, not
// instants), and widening the control plane's vocabulary is an amendment to
// spec 034 that this change does not need to make.
// ---------------------------------------------------------------------------

function requireInt(kind: string, obj: Record<string, unknown>, field: string): number {
  const value = obj[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new InvalidSpecError(kind, field, `expected an integer, got ${typeof value}`);
  }
  if (value < 0) throw new InvalidSpecError(kind, field, "must not be negative");
  return value;
}

function optionalInt(
  kind: string,
  obj: Record<string, unknown>,
  field: string,
  fallback: number,
): number {
  if (obj[field] === undefined || obj[field] === null) return fallback;
  return requireInt(kind, obj, field);
}

function requireBool(kind: string, obj: Record<string, unknown>, field: string): boolean {
  const value = obj[field];
  if (typeof value !== "boolean") {
    throw new InvalidSpecError(kind, field, `expected a boolean, got ${typeof value}`);
  }
  return value;
}

function requireDay(kind: string, obj: Record<string, unknown>, field: string): string {
  const value = requireString(kind, obj, field);
  if (!isDay(value)) {
    throw new InvalidSpecError(kind, field, `expected a calendar day (YYYY-MM-DD), got '${value}'`);
  }
  return value;
}

function optionalDay(
  kind: string,
  obj: Record<string, unknown>,
  field: string,
): string | undefined {
  if (obj[field] === undefined || obj[field] === null) return undefined;
  return requireDay(kind, obj, field);
}

// An address is checked for shape, not for deliverability. A validator that
// tries to be RFC 5322 rejects addresses that work; one that checks for a single
// `@` with something either side catches the typo that matters (a name pasted
// into the wrong field) and defers the rest to the mail path (spec 026).
function requireEmail(kind: string, obj: Record<string, unknown>, field: string): string {
  const value = requireString(kind, obj, field);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new InvalidSpecError(kind, field, `expected an email address, got '${value}'`);
  }
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// The kinds
// ---------------------------------------------------------------------------

export const tenantKind: Kind<TenantSpec> = {
  name: TENANT,
  // Cluster-scoped, and this is the one kind for which that is honest rather
  // than a placeholder: the tenant registry is the thing that lists tenants, so
  // it cannot itself be scoped to one.
  tenantScoped: false,
  validate(input) {
    const obj = requireObject(TENANT, input);
    const spec: TenantSpec = { displayName: requireString(TENANT, obj, "displayName") };
    const contactEmail = obj.contactEmail === undefined || obj.contactEmail === null
      ? undefined
      : requireEmail(TENANT, obj, "contactEmail");
    if (contactEmail) spec.contactEmail = contactEmail;
    return spec;
  },
};

export const tierKind: Kind<TierSpec> = {
  name: TIER,
  tenantScoped: true,
  validate(input) {
    const obj = requireObject(TIER, input);
    return {
      label: requireString(TIER, obj, "label"),
      duesCents: requireInt(TIER, obj, "duesCents"),
      period: requireEnum(TIER, obj, "period", ["annual", "monthly", "lifetime"] as const),
      votingRights: requireBool(TIER, obj, "votingRights"),
      graceDays: optionalInt(TIER, obj, "graceDays", 30),
    };
  },
};

export const memberKind: Kind<MemberSpec> = {
  name: MEMBER,
  tenantScoped: true,
  validate(input) {
    const obj = requireObject(MEMBER, input);
    const spec: MemberSpec = {
      displayName: requireString(MEMBER, obj, "displayName"),
      email: requireEmail(MEMBER, obj, "email"),
      joinedOn: requireDay(MEMBER, obj, "joinedOn"),
    };
    const sub = optionalString(MEMBER, obj, "sub");
    if (sub) spec.sub = sub;
    return spec;
  },
};

export const membershipKind: Kind<MembershipSpec> = {
  name: MEMBERSHIP,
  tenantScoped: true,
  validate(input) {
    const obj = requireObject(MEMBERSHIP, input);
    const spec: MembershipSpec = {
      member: requireString(MEMBERSHIP, obj, "member"),
      tier: requireString(MEMBERSHIP, obj, "tier"),
      startsOn: requireDay(MEMBERSHIP, obj, "startsOn"),
      autoRenew: requireBool(MEMBERSHIP, obj, "autoRenew"),
    };
    const endsOn = optionalDay(MEMBERSHIP, obj, "endsOn");
    if (endsOn) {
      if (endsOn < spec.startsOn) {
        throw new InvalidSpecError(MEMBERSHIP, "endsOn", `must not precede startsOn (${spec.startsOn})`);
      }
      spec.endsOn = endsOn;
    }
    // Whether `endsOn` is REQUIRED depends on the tier's period, and the tier is
    // another resource. That check is the renewal controller's (spec 036 §3.3):
    // a validator that reads a second resource would be enforcing referential
    // integrity at admission, which this domain deliberately does not do.
    return spec;
  },
};

export const duesInvoiceKind: Kind<DuesInvoiceSpec> = {
  name: DUES_INVOICE,
  tenantScoped: true,
  validate(input) {
    const obj = requireObject(DUES_INVOICE, input);
    return {
      membership: requireString(DUES_INVOICE, obj, "membership"),
      member: requireString(DUES_INVOICE, obj, "member"),
      tier: requireString(DUES_INVOICE, obj, "tier"),
      amountCents: requireInt(DUES_INVOICE, obj, "amountCents"),
      periodStart: requireDay(DUES_INVOICE, obj, "periodStart"),
      periodEnd: requireDay(DUES_INVOICE, obj, "periodEnd"),
      dueOn: requireDay(DUES_INVOICE, obj, "dueOn"),
    };
  },
};

/** Every kind this domain owns. */
export const MEMBERSHIP_KINDS: readonly Kind<unknown>[] = [
  tenantKind,
  tierKind,
  memberKind,
  membershipKind,
  duesInvoiceKind,
];

/**
 * Register all five with the control plane.
 *
 * Called rather than run at module load, so that a test which resets the
 * registry can put it back. `registerKind` is idempotent for the identical
 * definition and a refusal for a conflicting one (spec 034 §3.2), so calling
 * this twice is safe and calling it against a rival definition is the loud
 * failure it should be.
 */
export function registerMembershipKinds(): void {
  for (const kind of MEMBERSHIP_KINDS) registerKind(kind);
}
