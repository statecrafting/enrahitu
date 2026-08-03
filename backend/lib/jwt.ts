/**
 * RS256 token issuance and verification (spec 004, rewritten 2026-08-03).
 *
 * The access token is a short-lived (15 min) assertion the app mints ABOUT a
 * principal the IdP authenticated. Its subject is the IdP's `sub`, so the
 * session and the domain's principal bindings are the same identifier: before
 * this rewrite the subject was a locally minted account id, which meant a
 * `member.sub` recorded against rauthy could never match a session, and spec
 * 036 §3.8's "durable binding" had in fact never matched anything.
 *
 * **The app no longer mints refresh tokens.** The session envelope below is
 * transport for the authority's own refresh token, not a credential in its own
 * right: it carries no identity, grants nothing on presentation, and is
 * worthless without whatever the authority put inside it. Rotation and
 * revocation are the authority's (spec 001 §5.3), which is the cost accepted in
 * exchange for having exactly one session authority.
 */
import jwt from "jsonwebtoken";
import type { JwtPayload } from "jsonwebtoken";

import { accessPrivateKey, refreshPrivateKey, refreshPublicKey } from "./secrets";

import { AUDIENCE, ISSUER } from "./jwt-verify";

// Verification lives in jwt-verify.ts (public key only, spec 023 gate);
// re-exported here so issuance-side consumers keep one import surface.
export { verifyAccessToken } from "./jwt-verify";
export type { AccessTokenClaims } from "./jwt-verify";
import type { AccessTokenClaims } from "./jwt-verify";

/**
 * The app's own access-token lifetime, used only when no authority sets one
 * (the development driver). With rauthy the lifetime comes from rauthy.
 */
const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Mint the app's assertion about a principal.
 *
 * `ttlSeconds` is the AUTHORITY's access-token lifetime, and passing it is not
 * cosmetic. A rauthy refresh token carries `nbf = issued + access_token_lifetime
 * - 60`: it cannot be used until sixty seconds before the IdP's own access token
 * expires. So if this app expired its session earlier than rauthy expires its
 * own, every renewal would be refused as "not valid yet" and every user would be
 * logged out at the app's TTL with no way to recover. Following the authority's
 * clock is what keeps the two in step (spec 004 §3.4).
 */
export async function signAccessToken(
  claims: AccessTokenClaims,
  ttlSeconds = DEFAULT_ACCESS_TTL_SECONDS,
): Promise<string> {
  return jwt.sign(
    {
      email: claims.email,
      emailVerified: claims.emailVerified,
      name: claims.name,
      roles: claims.roles,
      ssoProvider: claims.ssoProvider,
    },
    accessPrivateKey(),
    {
      algorithm: "RS256",
      // The IdP's `sub`, which is what makes this token's subject the same
      // identifier the domain records as a principal binding.
      subject: claims.userID,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: ttlSeconds,
    },
  );
}

/**
 * What the session cookie carries between requests.
 *
 * `rauthy` holds the IdP's own refresh token: the app forwards it back to the
 * token endpoint and re-mints from whatever claims come out, so revoking the
 * session at rauthy revokes it here on the next refresh with nothing to
 * synchronize.
 *
 * It also pins the `subject`, for two reasons. A refresh grant does not return
 * a new id token, so the claims have to be re-read from userinfo, and userinfo
 * is asked about a specific subject. And pinning it means a renewal cannot
 * quietly change who the session belongs to.
 *
 * `mock` is the development driver and carries the profile itself, because
 * there is no authority behind it to ask. It exists so `npm run dev` works
 * without an IdP; it is refused in production by `isMockEnabled`.
 */
export type SessionEnvelope =
  | { driver: "rauthy"; refreshToken: string; subject: string }
  | { driver: "mock"; profileIndex: number };

export interface SignedSession {
  token: string;
  expiresAt: Date;
}

/**
 * Wrap the envelope in an app signature.
 *
 * The signature is integrity only, not authority: it stops a browser handing
 * back an envelope naming a different driver or a different mock profile. What
 * is inside still has to be honoured by whoever issued it, which for a real
 * deployment means rauthy.
 */
export async function signSession(envelope: SessionEnvelope): Promise<SignedSession> {
  const token = jwt.sign({ env: envelope }, refreshPrivateKey(), {
    algorithm: "RS256",
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: SESSION_TTL_SECONDS,
  });
  return { token, expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000) };
}

export async function verifySession(token: string): Promise<SessionEnvelope> {
  const payload = jwt.verify(token, refreshPublicKey(), {
    algorithms: ["RS256"],
    issuer: ISSUER,
    audience: AUDIENCE,
  }) as JwtPayload;
  const env = payload.env as SessionEnvelope | undefined;
  if (
    env?.driver === "rauthy" &&
    typeof env.refreshToken === "string" &&
    typeof env.subject === "string"
  ) {
    return env;
  }
  if (env?.driver === "mock" && Number.isInteger(env.profileIndex)) return env;
  throw new Error("session envelope is not a shape this app issues");
}

/** Distinguishes an expired access token so the handler can surface TOKEN_EXPIRED. */
export function isTokenExpiredError(err: unknown): boolean {
  return err instanceof jwt.TokenExpiredError;
}
