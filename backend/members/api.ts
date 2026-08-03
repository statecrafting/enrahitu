/**
 * The membership API (spec 036 §3.8): an operator plane and a member plane,
 * gated differently.
 *
 * The operator plane is the association's staff and requires the
 * `<app>_operator` role. The member plane is one endpoint that answers strictly
 * about the caller: it takes no name parameter, so there is no version of it
 * that reads somebody else's record. That is spec 001 §4.4's operator/user
 * separation reaching the domain for the first time.
 *
 * Every handler runs under the `members` service's own kernel attribution, which
 * is why this service declares its own state grants rather than calling through
 * the control plane's (spec 034 §2).
 */
import { api, APIError, Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";

import { get, list, retract, setStatus } from "../control";
import { operatorRole, requireRole } from "../lib/roles";

import { resolvePaidOn, today } from "./dates";
import { findLinkedMember } from "./identity";
import {
  DUES_INVOICE,
  MEMBER,
  MEMBERSHIP,
  TENANT,
  TIER,
  type BillingPeriod,
  type DuesInvoiceSpec,
  type InvoiceState,
  type InvoiceStatus,
  type MemberSpec,
  type MembershipSpec,
  type MembershipState,
  type MembershipStatus,
  type TenantSpec,
  type TierSpec,
} from "./kinds";
import { guarded, writeSpec } from "./store";
import { tenantId } from "./tenant";

function requireOperator(): string {
  const auth = getAuthData()!;
  requireRole(auth, operatorRole());
  return auth.email;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface MemberView {
  name: string;
  displayName: string;
  email: string;
  sub?: string;
  joinedOn: string;
  revision: number;
  /** The value to send back on an update, so a stale edit is refused (spec 036 §3.4). */
  fence: number;
}

export interface MembershipView {
  name: string;
  member: string;
  tier: string;
  startsOn: string;
  endsOn?: string;
  autoRenew: boolean;
  state: MembershipState;
  renewsOn?: string;
  lapsedOn?: string;
  currentInvoice?: string;
  problem?: string;
  revision: number;
  fence: number;
}

export interface TierView {
  name: string;
  label: string;
  duesCents: number;
  period: BillingPeriod;
  votingRights: boolean;
  graceDays: number;
  revision: number;
  fence: number;
}

export interface InvoiceView {
  name: string;
  membership: string;
  member: string;
  tier: string;
  amountCents: number;
  periodStart: string;
  periodEnd: string;
  dueOn: string;
  state: InvoiceState;
  paidOn?: string;
  recordedBy?: string;
  revision: number;
  fence: number;
}

interface Stored<TSpec> {
  name: string;
  spec: TSpec;
  status: unknown;
  revision: number;
  fence: number;
}

function memberView(r: Stored<MemberSpec>): MemberView {
  const view: MemberView = {
    name: r.name,
    displayName: r.spec.displayName,
    email: r.spec.email,
    joinedOn: r.spec.joinedOn,
    revision: r.revision,
    fence: r.fence,
  };
  if (r.spec.sub) view.sub = r.spec.sub;
  return view;
}

function membershipView(r: Stored<MembershipSpec>): MembershipView {
  const status = (r.status as MembershipStatus | null) ?? { state: "pending" as const };
  const view: MembershipView = {
    name: r.name,
    member: r.spec.member,
    tier: r.spec.tier,
    startsOn: r.spec.startsOn,
    autoRenew: r.spec.autoRenew,
    state: status.state,
    revision: r.revision,
    fence: r.fence,
  };
  if (r.spec.endsOn) view.endsOn = r.spec.endsOn;
  if (status.renewsOn) view.renewsOn = status.renewsOn;
  if (status.lapsedOn) view.lapsedOn = status.lapsedOn;
  if (status.currentInvoice) view.currentInvoice = status.currentInvoice;
  if (status.problem) view.problem = status.problem;
  return view;
}

function tierView(r: Stored<TierSpec>): TierView {
  return {
    name: r.name,
    label: r.spec.label,
    duesCents: r.spec.duesCents,
    period: r.spec.period,
    votingRights: r.spec.votingRights,
    graceDays: r.spec.graceDays,
    revision: r.revision,
    fence: r.fence,
  };
}

function invoiceView(r: Stored<DuesInvoiceSpec>): InvoiceView {
  const status = (r.status as InvoiceStatus | null) ?? { state: "open" as const };
  const view: InvoiceView = {
    name: r.name,
    membership: r.spec.membership,
    member: r.spec.member,
    tier: r.spec.tier,
    amountCents: r.spec.amountCents,
    periodStart: r.spec.periodStart,
    periodEnd: r.spec.periodEnd,
    dueOn: r.spec.dueOn,
    state: status.state,
    revision: r.revision,
    fence: r.fence,
  };
  if (status.paidOn) view.paidOn = status.paidOn;
  if (status.recordedBy) view.recordedBy = status.recordedBy;
  return view;
}

// ---------------------------------------------------------------------------
// The association record
// ---------------------------------------------------------------------------

export interface OrgResponse {
  tenant: string;
  displayName: string;
  contactEmail?: string;
}

export const getOrg = api(
  { expose: true, auth: true, method: "GET", path: "/api/org" },
  async (): Promise<OrgResponse> => {
    const tenant = tenantId();
    const record = await guarded(() => get<TenantSpec>(TENANT, tenant));
    const response: OrgResponse = {
      tenant,
      displayName: record?.spec.displayName ?? tenant,
    };
    if (record?.spec.contactEmail) response.contactEmail = record.spec.contactEmail;
    return response;
  },
);

export interface PutOrgRequest {
  displayName: string;
  contactEmail?: string;
  fence?: number;
}

export const putOrg = api(
  { expose: true, auth: true, method: "PUT", path: "/api/org" },
  async (req: PutOrgRequest): Promise<OrgResponse> => {
    const actor = requireOperator();
    const tenant = tenantId();
    // The tenant kind is cluster-scoped, so no tenant option: it is the registry
    // that lists tenants and cannot be scoped to one (spec 036 §3.1).
    const existing = await guarded(() => get<TenantSpec>(TENANT, tenant));
    const spec: Record<string, unknown> = { displayName: req.displayName };
    if (req.contactEmail) spec.contactEmail = req.contactEmail;
    const stored = await guarded(() =>
      writeSpec<TenantSpec>(TENANT, tenant, spec, {
        tenant: "",
        actor,
        expected: req.fence ?? existing?.fence ?? 0,
      }),
    );
    const response: OrgResponse = { tenant, displayName: stored.spec.displayName };
    if (stored.spec.contactEmail) response.contactEmail = stored.spec.contactEmail;
    return response;
  },
);

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

export interface TierList {
  tiers: TierView[];
}

export const listTiers = api(
  { expose: true, auth: true, method: "GET", path: "/api/tiers" },
  async (): Promise<TierList> => {
    requireOperator();
    const tiers = await guarded(() => list<TierSpec>(TIER, { tenant: tenantId() }));
    return { tiers: tiers.map(tierView) };
  },
);

export interface PutTierRequest {
  name: string;
  label: string;
  duesCents: number;
  period: BillingPeriod;
  votingRights: boolean;
  graceDays?: number;
  fence?: number;
}

export const putTier = api(
  { expose: true, auth: true, method: "PUT", path: "/api/tiers/:name" },
  async (req: PutTierRequest): Promise<TierView> => {
    const actor = requireOperator();
    const spec: Record<string, unknown> = {
      label: req.label,
      duesCents: req.duesCents,
      period: req.period,
      votingRights: req.votingRights,
    };
    if (req.graceDays !== undefined) spec.graceDays = req.graceDays;
    const stored = await writeSpec<TierSpec>(TIER, req.name, spec, {
      tenant: tenantId(),
      actor,
      ...(req.fence === undefined ? {} : { expected: req.fence }),
    });
    return tierView(stored);
  },
);

export interface ByName {
  name: string;
}

export interface Retracted {
  retracted: boolean;
}

export const deleteTier = api(
  { expose: true, auth: true, method: "DELETE", path: "/api/tiers/:name" },
  async (req: ByName): Promise<Retracted> => {
    const actor = requireOperator();
    // Retracting a tier that memberships still reference is allowed on purpose:
    // the renewal controller reports each affected membership as `invalid`
    // naming this tier, which shows what it broke (spec 036 §3.3).
    const gone = await guarded(() => retract(TIER, req.name, { tenant: tenantId(), actor }));
    return { retracted: gone !== null };
  },
);

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export interface MemberRow {
  member: MemberView;
  membership?: MembershipView;
}

export interface MemberList {
  members: MemberRow[];
}

async function membershipsByMember(tenant: string): Promise<Map<string, MembershipView>> {
  const memberships = await list<MembershipSpec>(MEMBERSHIP, { tenant });
  const byMember = new Map<string, MembershipView>();
  for (const m of memberships) byMember.set(m.spec.member, membershipView(m));
  return byMember;
}

export const listMembers = api(
  { expose: true, auth: true, method: "GET", path: "/api/members" },
  async (): Promise<MemberList> => {
    requireOperator();
    const tenant = tenantId();
    return guarded(async () => {
      const [members, byMember] = await Promise.all([
        list<MemberSpec>(MEMBER, { tenant }),
        membershipsByMember(tenant),
      ]);
      return {
        members: members.map((m) => {
          const row: MemberRow = { member: memberView(m) };
          const membership = byMember.get(m.name);
          if (membership) row.membership = membership;
          return row;
        }),
      };
    });
  },
);

export interface MemberDetail {
  member: MemberView;
  membership?: MembershipView;
  invoices: InvoiceView[];
}

export const getMember = api(
  { expose: true, auth: true, method: "GET", path: "/api/members/:name" },
  async (req: ByName): Promise<MemberDetail> => {
    requireOperator();
    const tenant = tenantId();
    return guarded(async () => {
      const member = await get<MemberSpec>(MEMBER, req.name, { tenant });
      if (!member) throw APIError.notFound(`no member '${req.name}'`);
      return detailFor(tenant, member);
    });
  },
);

async function detailFor(tenant: string, member: Stored<MemberSpec>): Promise<MemberDetail> {
  const [memberships, invoices] = await Promise.all([
    list<MembershipSpec>(MEMBERSHIP, { tenant }),
    list<DuesInvoiceSpec>(DUES_INVOICE, { tenant }),
  ]);
  const mine = memberships.find((m) => m.spec.member === member.name);
  const detail: MemberDetail = {
    member: memberView(member),
    invoices: invoices.filter((i) => i.spec.member === member.name).map(invoiceView),
  };
  if (mine) detail.membership = membershipView(mine);
  return detail;
}

export interface PutMemberRequest {
  name: string;
  displayName: string;
  email: string;
  joinedOn: string;
  sub?: string;
  fence?: number;
}

export const putMember = api(
  { expose: true, auth: true, method: "PUT", path: "/api/members/:name" },
  async (req: PutMemberRequest): Promise<MemberView> => {
    const actor = requireOperator();
    const spec: Record<string, unknown> = {
      displayName: req.displayName,
      email: req.email,
      joinedOn: req.joinedOn,
    };
    if (req.sub) spec.sub = req.sub;
    const stored = await writeSpec<MemberSpec>(MEMBER, req.name, spec, {
      tenant: tenantId(),
      actor,
      ...(req.fence === undefined ? {} : { expected: req.fence }),
    });
    return memberView(stored);
  },
);

export const deleteMember = api(
  { expose: true, auth: true, method: "DELETE", path: "/api/members/:name" },
  async (req: ByName): Promise<Retracted> => {
    const actor = requireOperator();
    const gone = await guarded(() => retract(MEMBER, req.name, { tenant: tenantId(), actor }));
    return { retracted: gone !== null };
  },
);

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

export interface MembershipList {
  memberships: MembershipView[];
}

export const listMemberships = api(
  { expose: true, auth: true, method: "GET", path: "/api/memberships" },
  async (): Promise<MembershipList> => {
    requireOperator();
    const memberships = await guarded(() =>
      list<MembershipSpec>(MEMBERSHIP, { tenant: tenantId() }),
    );
    return { memberships: memberships.map(membershipView) };
  },
);

export interface PutMembershipRequest {
  name: string;
  member: string;
  tier: string;
  startsOn: string;
  endsOn?: string;
  autoRenew: boolean;
  fence?: number;
}

export const putMembership = api(
  { expose: true, auth: true, method: "PUT", path: "/api/memberships/:name" },
  async (req: PutMembershipRequest): Promise<MembershipView> => {
    const actor = requireOperator();
    const spec: Record<string, unknown> = {
      member: req.member,
      tier: req.tier,
      startsOn: req.startsOn,
      autoRenew: req.autoRenew,
    };
    if (req.endsOn) spec.endsOn = req.endsOn;
    const stored = await writeSpec<MembershipSpec>(MEMBERSHIP, req.name, spec, {
      tenant: tenantId(),
      actor,
      ...(req.fence === undefined ? {} : { expected: req.fence }),
    });
    return membershipView(stored);
  },
);

// ---------------------------------------------------------------------------
// Dues
// ---------------------------------------------------------------------------

export interface InvoiceList {
  invoices: InvoiceView[];
}

export const listDues = api(
  { expose: true, auth: true, method: "GET", path: "/api/dues" },
  async (): Promise<InvoiceList> => {
    requireOperator();
    const invoices = await guarded(() =>
      list<DuesInvoiceSpec>(DUES_INVOICE, { tenant: tenantId() }),
    );
    return { invoices: invoices.map(invoiceView) };
  },
);

/**
 * Record a payment: a status write on an invoice.
 *
 * The membership renews without this handler touching it. The controller sees
 * the invoice change, re-evaluates the membership, and extends the term (spec
 * 036 §3.7). That indirection is the point: the renewal rule lives in one place
 * and every route into it converges through the same code.
 *
 * **`paidOn` is a query parameter and not a body field**, which is forced rather
 * than chosen. An optional field in the body makes the body mandatory: a plain
 * `POST .../paid` then fails with "unable to decode request body: EOF while
 * parsing a value at line 1 column 0", which is a terrible answer to a correct
 * request. A query parameter leaves the bare POST answering 200 and carries the
 * day when a treasurer sends one.
 *
 * An earlier revision recorded that the query-parameter form "parsed on the host
 * and failed in the container". That was wrong, and spec 036 §3.9 records how
 * the wrong conclusion was reached; both forms are asserted at both ends now.
 * The body-field failure above is real and reproduces; the divergence did not.
 *
 * Backdating cannot move a term. The renewal rule reads only the invoice's state
 * and its `periodEnd` (§3.7), so `paidOn` is a record of when money arrived and
 * never an input to what it bought.
 */
interface RecordPaymentReq {
  name: string;
  /** The day payment was received, when that was not today. A UTC calendar day. */
  paidOn?: Query<string>;
}

export const recordPayment = api(
  { expose: true, auth: true, method: "POST", path: "/api/dues/:name/paid" },
  async (req: RecordPaymentReq): Promise<InvoiceView> => {
    const actor = requireOperator();
    const tenant = tenantId();
    const paidOn = resolvePaidOn(req.paidOn, today());
    if (!paidOn.ok) throw APIError.invalidArgument(paidOn.problem);
    return guarded(async () => {
      const invoice = await get<DuesInvoiceSpec>(DUES_INVOICE, req.name, { tenant });
      if (!invoice) throw APIError.notFound(`no invoice '${req.name}'`);
      const status: InvoiceStatus = {
        state: "paid",
        paidOn: paidOn.day,
        recordedBy: actor,
      };
      const stored = await setStatus<DuesInvoiceSpec>(DUES_INVOICE, req.name, status, {
        tenant,
        fence: invoice.fence,
        actor,
      });
      return invoiceView(stored!);
    });
  },
);

export const voidInvoice = api(
  { expose: true, auth: true, method: "POST", path: "/api/dues/:name/void" },
  async (req: ByName): Promise<InvoiceView> => {
    const actor = requireOperator();
    const tenant = tenantId();
    return guarded(async () => {
      const invoice = await get<DuesInvoiceSpec>(DUES_INVOICE, req.name, { tenant });
      if (!invoice) throw APIError.notFound(`no invoice '${req.name}'`);
      const stored = await setStatus<DuesInvoiceSpec>(
        DUES_INVOICE,
        req.name,
        { state: "void" } satisfies InvoiceStatus,
        { tenant, fence: invoice.fence, actor },
      );
      return invoiceView(stored!);
    });
  },
);

// ---------------------------------------------------------------------------
// The member plane
// ---------------------------------------------------------------------------

export interface MyMembership {
  member: MemberView;
  membership?: MembershipView;
  outstanding: InvoiceView[];
}

/**
 * The caller's own record, and nothing else.
 *
 * No name parameter by construction: an endpoint that reads "the member named
 * X" and then checks whether X is you is one refactor away from forgetting.
 *
 * The join to identity is `sub` first and verified email second. Spec 001 §5.3
 * makes `sub` the durable binding, but a member record usually exists before its
 * person ever logs in, so requiring it would leave every pre-enrolled member
 * unable to see their own dues. The email fallback retires when spec 004's
 * rewrite gives the session rauthy's subject and enrollment can write it.
 */
export const myMembership = api(
  { expose: true, auth: true, method: "GET", path: "/api/me/membership" },
  async (): Promise<MyMembership> => {
    const auth = getAuthData()!;
    const tenant = tenantId();
    return guarded(async () => {
      const members = await list<MemberSpec>(MEMBER, { tenant });
      const mine = findLinkedMember(members, {
        userID: auth.userID,
        email: auth.email,
        emailVerified: auth.emailVerified,
      });
      if (!mine) {
        throw APIError.notFound(
          "no membership record is linked to this account; the association's staff can link one",
        );
      }
      const detail = await detailFor(tenant, mine);
      const response: MyMembership = {
        member: detail.member,
        outstanding: detail.invoices.filter((i) => i.state === "open"),
      };
      if (detail.membership) response.membership = detail.membership;
      return response;
    });
  },
);
