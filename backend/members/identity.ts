/**
 * The join from a session to a member record (spec 036 §3.8).
 *
 * Its own module, with no Encore import, so the rule can be tested directly.
 * "Which record is yours" is the whole of the member plane's authorization, and
 * a rule that can only be exercised through an authenticated HTTP request is one
 * that gets tested through the happy path and nothing else.
 *
 * `sub` first, verified email second. Spec 001 §5.3 makes rauthy's subject the
 * durable binding, but an association enrolls members before they ever log in,
 * so requiring `sub` would leave every pre-enrolled member unable to see their
 * own dues. The email is the IdP's verified claim rather than user input, which
 * is what makes it safe to match on; it retires as a fallback when spec 004's
 * rewrite lets enrollment write `sub` at first login.
 */
import type { MemberSpec } from "./kinds";

export interface SessionIdentity {
  userID: string;
  email: string;
}

export interface LinkableMember {
  name: string;
  spec: MemberSpec;
}

/** The caller's own member record, or null when nothing is linked to them. */
export function findLinkedMember<T extends LinkableMember>(
  members: readonly T[],
  session: SessionIdentity,
): T | null {
  const bySub = members.find((m) => m.spec.sub !== undefined && m.spec.sub === session.userID);
  if (bySub) return bySub;

  const email = session.email.trim().toLowerCase();
  if (!email) return null;
  // Member emails are lowercased by the kind's validator, so this compares like
  // with like rather than hoping both sides were normalized by the same hand.
  return members.find((m) => m.spec.email === email) ?? null;
}
