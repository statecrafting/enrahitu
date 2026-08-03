/**
 * POST /api/v1/auth/refresh (spec 004, rewritten 2026-08-03).
 *
 * **This is where "rauthy is the session authority" stops being a slogan.**
 * Before the rewrite this endpoint checked a locally stored refresh-token hash,
 * rotated it, and issued a new pair: the app decided whether a session was
 * still alive, which meant an administrator revoking a user at rauthy left them
 * logged in here until their own token expired.
 *
 * Now the app forwards the IdP's refresh token back to the IdP and re-mints
 * from whatever claims come out. Revocation, rotation and lifetime are rauthy's,
 * and there is nothing to keep in step because the app stores nothing. Roles and
 * email verification are re-read on every refresh rather than carried forward,
 * so a role removed at the IdP takes effect within one access-token lifetime.
 *
 * CSRF-exempt, as before: it cannot carry a prior-issued token.
 */
import { api } from "encore.dev/api";
import * as client from "openid-client";

import { writeAudit } from "../lib/audit";
import { logWarn } from "../lib/logger";
import { REFRESH_COOKIE } from "../lib/cookie-config";
import { clearAuthCookies, parseCookies, setAuthCookies } from "../lib/cookies";
import { verifySession, type SessionEnvelope } from "../lib/jwt";

import { clientIp, userAgent, writeJson } from "./http";
import { MOCK_USERS, isMockEnabled } from "./mock";
import { isRauthyConfigured, profileFromClaims, rauthyConfig } from "./rauthy";
import { issueTokenPair } from "./service";
import type { SSOProfile } from "./types";

function deny(res: Parameters<typeof clearAuthCookies>[0], message: string): void {
  clearAuthCookies(res);
  writeJson(res, 401, { code: "unauthenticated", message });
}

/**
 * Trade the IdP's refresh token for current claims.
 *
 * Returns the profile and the refresh token to store next. rauthy may rotate on
 * use, in which case the new one replaces the old; when it does not, the same
 * token rides on, and either way the app is only ever repeating what it was
 * given.
 */
async function refreshFromRauthy(
  envelope: Extract<SessionEnvelope, { driver: "rauthy" }>,
): Promise<{ profile: SSOProfile; refreshToken: string; expiresIn?: number } | null> {
  if (!isRauthyConfigured()) {
    logWarn("auth: a rauthy session cannot be renewed because the driver is not configured", {});
    return null;
  }
  if (!envelope.refreshToken) {
    // The IdP gave us nothing to renew with. Logged rather than silently 401ed,
    // because the operator-visible symptom is "everybody is logged out every
    // fifteen minutes" and the cause is a client that was never allowed to
    // issue refresh tokens (spec 004 §3.4).
    logWarn("auth: the session carries no IdP refresh token; renewal is impossible", {
      detail:
        "rauthy must have the refresh_token flow enabled for this client and the login must " +
        "request the offline_access scope (RAUTHY_SCOPES).",
    });
    return null;
  }
  try {
    const config = await rauthyConfig();
    const tokens = await client.refreshTokenGrant(config, envelope.refreshToken);

    // UNRESOLVED (2026-08-03): against dev rauthy this grant fails client
    // authentication at the token endpoint ("server responded with a challenge
    // in the WWW-Authenticate HTTP Header"), while the authorization-code grant
    // succeeds with the same discovered config and the same client secret. Until
    // that is understood, renewal 401s and a session lasts one access-token
    // lifetime. See spec 004 §3.4 and the branch note; this must not ship.
    //
    // A refresh grant also returns no id token, so the claims come from
    // userinfo, asked about the subject the envelope pinned at login.
    const claims =
      tokens.claims() ??
      (await client.fetchUserInfo(config, tokens.access_token, envelope.subject));

    return {
      profile: profileFromClaims(claims as unknown as Record<string, unknown>),
      refreshToken: tokens.refresh_token ?? envelope.refreshToken,
      ...(tokens.expires_in === undefined ? {} : { expiresIn: tokens.expires_in }),
    };
  } catch (err) {
    // A refused grant is the normal shape of "this session is over": revoked,
    // expired, or rotated out from under us. It is a 401, not an error page.
    // It is still logged, because "revoked" and "misconfigured" produce the
    // same 401 and only the log tells them apart.
    logWarn("auth: the identity provider refused to renew this session", {
      error: String((err as Error)?.message ?? err),
    });
    return null;
  }
}

export const refresh = api.raw(
  { expose: true, method: "POST", path: "/api/v1/auth/refresh" },
  async (req, res) => {
    const presented = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
    if (!presented) return deny(res, "no session");

    let envelope: SessionEnvelope;
    try {
      envelope = await verifySession(presented);
    } catch {
      return deny(res, "invalid session");
    }

    let profile: SSOProfile;
    let next: SessionEnvelope;
    let accessTtl: number | undefined;

    if (envelope.driver === "rauthy") {
      const refreshed = await refreshFromRauthy(envelope);
      if (!refreshed) return deny(res, "the identity provider did not renew this session");
      profile = refreshed.profile;
      accessTtl = refreshed.expiresIn;
      next = {
        driver: "rauthy",
        refreshToken: refreshed.refreshToken,
        // The subject the envelope pinned, not one a renewal could change.
        subject: envelope.subject,
      };
    } else {
      // The development driver has no authority to ask, so the envelope's
      // profile index is the whole of it. Refused outright in production, where
      // a session that renews itself with no authority behind it would be a
      // permanent credential.
      if (!isMockEnabled()) return deny(res, "the mock driver is disabled");
      const mock = MOCK_USERS[envelope.profileIndex];
      if (!mock) return deny(res, "unknown mock profile");
      profile = mock;
      next = envelope;
    }

    const pair = await issueTokenPair(profile, next, accessTtl);
    setAuthCookies(res, pair);
    await writeAudit({
      action: "auth.refresh",
      actorId: profile.subject,
      actorEmail: profile.email,
      ipAddress: clientIp(req),
      userAgent: userAgent(req),
    });
    writeJson(res, 200, { status: "ok" });
  },
);
