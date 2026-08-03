/**
 * Login finalization (spec 004, rewritten 2026-08-03).
 *
 * **There is no local account row any more.** `upsertUserFromProfile` used to
 * run here and mint a `UserAccount` whose random id became the session's
 * subject; rauthy's own `sub` was filed away as `ssoProviderId` and never
 * reached the token. That is why spec 036 §3.8's `member.sub` binding had never
 * matched a session: the two identifiers were from different namespaces, and
 * only the email fallback ever did any work.
 *
 * Now the authority's `sub` IS the subject. Nothing is stored at login: a
 * principal exists because rauthy says so, not because this app wrote a row
 * about them.
 *
 * The cookie shell is unchanged (same-origin, httpOnly, CSRF double-submit),
 * which is the half of spec 001 §5.3 that survives. What retires is the app's
 * own rotation and revocation.
 */
import type { ServerResponse } from "node:http";

import { writeAudit } from "../lib/audit";
import { setAuthCookies } from "../lib/cookies";
import { env } from "../lib/env";
import { signAccessToken, signSession, type SessionEnvelope } from "../lib/jwt";

import type { SSOProfile } from "./types";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * The short-lived assertion the app makes about a principal the IdP authenticated.
 *
 * `ttlSeconds` is the authority's own access-token lifetime when there is an
 * authority. See the note on `signAccessToken`: expiring earlier than rauthy
 * does would make every renewal arrive before the refresh token's `nbf` and
 * log everybody out permanently.
 */
export async function issueAccessToken(
  profile: SSOProfile,
  ttlSeconds?: number,
): Promise<string> {
  return signAccessToken(
    {
      userID: profile.subject,
      email: profile.email,
      emailVerified: profile.emailVerified,
      name: profile.name,
      roles: profile.roles,
      ssoProvider: profile.ssoProvider,
    },
    ttlSeconds,
  );
}

export async function issueTokenPair(
  profile: SSOProfile,
  envelope: SessionEnvelope,
  ttlSeconds?: number,
): Promise<TokenPair> {
  const accessToken = await issueAccessToken(profile, ttlSeconds);
  const session = await signSession(envelope);
  return { accessToken, refreshToken: session.token };
}

export async function finalizeLogin(
  res: ServerResponse,
  profile: SSOProfile,
  envelope: SessionEnvelope,
  meta?: { ipAddress?: string; userAgent?: string; accessTtlSeconds?: number },
): Promise<SSOProfile> {
  const pair = await issueTokenPair(profile, envelope, meta?.accessTtlSeconds);
  setAuthCookies(res, pair);
  // AuditLog outlives the auth rewrite (spec 001 §5.3): it is application data
  // about what happened, not session state. The actor is now the IdP's subject,
  // so an audit trail written before and after this change refers to the same
  // person by two identifiers; that discontinuity is recorded in spec 004.
  await writeAudit({
    action: "auth.login",
    recordId: profile.subject,
    actorId: profile.subject,
    actorEmail: profile.email,
    ipAddress: meta?.ipAddress,
    userAgent: meta?.userAgent,
    newData: { ssoProvider: profile.ssoProvider },
  });
  return profile;
}

export function frontendUrl(path = "/"): string {
  return new URL(path, env.frontendUrl).toString();
}
