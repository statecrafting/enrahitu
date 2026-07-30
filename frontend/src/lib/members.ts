/**
 * The membership client (spec 036).
 *
 * Same rules as `api.ts`: same-origin, httpOnly cookies, CSRF replayed on every
 * unsafe method. Nothing here ever sees a token.
 *
 * Reads return a failure value rather than throwing, because this surface has
 * three refusals a member of staff will actually meet and each deserves a
 * sentence rather than a stack trace: 403 when they are not an operator, 503
 * when the deployment's schema has not been applied yet (spec 036 §3.6), and 404
 * when no member record is linked to their account.
 */
import { csrfToken, refresh } from "./api";

export type MembershipState = "active" | "pending" | "lapsed" | "invalid";
export type InvoiceState = "open" | "paid" | "void";

export interface MemberView {
  name: string;
  displayName: string;
  email: string;
  sub?: string;
  joinedOn: string;
  revision: number;
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
  period: "annual" | "monthly" | "lifetime";
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

export interface MemberRow {
  member: MemberView;
  membership?: MembershipView;
}

export interface MemberDetail {
  member: MemberView;
  membership?: MembershipView;
  invoices: InvoiceView[];
}

export interface MyMembership {
  member: MemberView;
  membership?: MembershipView;
  outstanding: InvoiceView[];
}

export interface OrgView {
  tenant: string;
  displayName: string;
  contactEmail?: string;
}

export interface Failure {
  failed: true;
  status: number;
  message: string;
}

export type Result<T> = T | Failure;

export function isFailure<T>(value: Result<T>): value is Failure {
  return typeof value === "object" && value !== null && (value as Failure).failed === true;
}

async function describe(res: Response): Promise<Failure> {
  let message = `request failed (${res.status})`;
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) message = body.message;
  } catch {
    // A non-JSON body is itself uninformative; the status carries the meaning.
  }
  return { failed: true, status: res.status, message };
}

/**
 * Send it, and on a 401 rotate the access token once and send it again.
 *
 * `fetchMe` has done this since spec 015 and these screens have to as well.
 * Without it, the first request after the access token's TTL renders "the
 * request does not have valid authentication credentials" to somebody with a
 * perfectly good session, and the fix they will find is reloading the page.
 * Found by leaving a tab open across a container restart, which is a thing that
 * happens to a user roughly as often as it happened here.
 */
async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const options: RequestInit = { credentials: "same-origin", ...init };
  const res = await fetch(path, options);
  if (res.status !== 401) return res;
  if (!(await refresh())) return res;
  return fetch(path, options);
}

async function read<T>(path: string): Promise<Result<T>> {
  const res = await send(path);
  if (!res.ok) return describe(res);
  return (await res.json()) as T;
}

async function write<T>(path: string, method: string, body?: unknown): Promise<Result<T>> {
  const token = await csrfToken();
  const res = await send(path, {
    method,
    headers: {
      "X-CSRF-Token": token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) return describe(res);
  return (await res.json()) as T;
}

export const fetchOrg = (): Promise<Result<OrgView>> => read<OrgView>("/api/org");

export const fetchMembers = (): Promise<Result<{ members: MemberRow[] }>> =>
  read<{ members: MemberRow[] }>("/api/members");

export const fetchMember = (name: string): Promise<Result<MemberDetail>> =>
  read<MemberDetail>(`/api/members/${encodeURIComponent(name)}`);

export const fetchTiers = (): Promise<Result<{ tiers: TierView[] }>> =>
  read<{ tiers: TierView[] }>("/api/tiers");

export const fetchDues = (): Promise<Result<{ invoices: InvoiceView[] }>> =>
  read<{ invoices: InvoiceView[] }>("/api/dues");

export const fetchMyMembership = (): Promise<Result<MyMembership>> =>
  read<MyMembership>("/api/me/membership");

export interface MemberInput {
  displayName: string;
  email: string;
  joinedOn: string;
  /** The fence read with the record. Sending it makes a stale edit fail loudly (spec 036 §3.4). */
  fence?: number;
}

export const putMember = (name: string, input: MemberInput): Promise<Result<MemberView>> =>
  write<MemberView>(`/api/members/${encodeURIComponent(name)}`, "PUT", input);

export interface MembershipInput {
  member: string;
  tier: string;
  startsOn: string;
  endsOn?: string;
  autoRenew: boolean;
  fence?: number;
}

export const putMembership = (
  name: string,
  input: MembershipInput,
): Promise<Result<MembershipView>> =>
  write<MembershipView>(`/api/memberships/${encodeURIComponent(name)}`, "PUT", input);

export const recordPayment = (name: string): Promise<Result<InvoiceView>> =>
  write<InvoiceView>(`/api/dues/${encodeURIComponent(name)}/paid`, "POST");

export const voidInvoice = (name: string): Promise<Result<InvoiceView>> =>
  write<InvoiceView>(`/api/dues/${encodeURIComponent(name)}/void`, "POST");

/** Cents as the association would write it on a notice. */
export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
