/**
 * The join from a session to a member record (spec 036 §3.8).
 *
 * Its own module, with no Encore import, so the rule can be tested directly.
 * "Which record is yours" is the whole of the member plane's authorization, and
 * a rule that can only be exercised through an authenticated HTTP request is one
 * that gets tested through the happy path and nothing else.
 *
 * `sub` first, VERIFIED email second. Spec 001 §5.3 makes the IdP's subject the
 * durable binding, but an association enrolls members long before any of them
 * logs in, so requiring `sub` would leave every pre-enrolled member unable to
 * see their own dues.
 *
 * **Both halves of that were broken until spec 004's rewrite (2026-08-03), and
 * the way they were broken is worth keeping written down.** The session's
 * `userID` was a locally minted account id rather than the IdP's `sub`, so the
 * first branch could never match anything and every lookup fell through to the
 * second. And the second matched on an address nothing had checked: no
 * `email_verified` was carried, and the SSO profile substituted
 * `preferred_username` when the email claim was absent. The safety of the
 * fallback was asserted in a comment and implemented nowhere.
 *
 * Now `userID` is the IdP's subject and the fallback requires the IdP to have
 * said it verified the address. The fallback still exists, and still retires:
 * once enrollment writes `sub` at first login, matching on an address at all
 * becomes unnecessary.
 */
import type { MemberSpec } from "./kinds";

export interface SessionIdentity {
  userID: string;
  email: string;
  /** The IdP's claim, never inferred. Absent means unverified. */
  emailVerified: boolean;
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
  // An empty subject links nothing. A session with no subject is not a session
  // this app issued, but a member record with no `sub` is ordinary, and
  // `undefined === undefined` would hand the first unbound member to anybody.
  if (session.userID) {
    const bySub = members.find((m) => m.spec.sub !== undefined && m.spec.sub === session.userID);
    if (bySub) return bySub;
  }

  // An unverified address is not evidence of anything. Registering an account
  // with somebody else's address is the attack this refuses, and the whole cost
  // of refusing it is that a member whose IdP has not verified them sees no
  // record until they do, or until an operator binds their `sub`.
  if (!session.emailVerified) return null;

  const email = session.email.trim().toLowerCase();
  if (!email) return null;
  // Member emails are lowercased by the kind's validator, so this compares like
  // with like rather than hoping both sides were normalized by the same hand.
  return members.find((m) => m.spec.email === email) ?? null;
}
