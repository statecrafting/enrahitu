/**
 * Access-token verification, split from jwt.ts (spec 004, amended by spec
 * 023): this module imports ONLY the public-key accessor, so a service
 * that merely verifies sessions (the admin gate) observes and declares
 * secret.read on jwt_public_key alone, never the signing keys. Issuance
 * and refresh-token handling stay in jwt.ts.
 */
import jwt from "jsonwebtoken";
import type { JwtPayload } from "jsonwebtoken";

import { accessPublicKey } from "./secrets";

export const ISSUER = "enrahitu";
export const AUDIENCE = "enrahitu-spa";

export interface AccessTokenClaims {
  userID: string;
  email: string;
  /**
   * Whether the identity provider says it verified this address.
   *
   * Carried because it is an authorization input, not decoration: spec 036
   * §3.8 joins a session to a member record by email when no `sub` binding
   * exists yet, and matching on an address nobody proved control of would let
   * an account read another member's record. Absent claim means false: an IdP
   * that does not say is an IdP that did not verify.
   */
  emailVerified: boolean;
  name: string;
  roles: string[];
  ssoProvider: string;
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const payload = jwt.verify(token, accessPublicKey(), {
    algorithms: ["RS256"],
    issuer: ISSUER,
    audience: AUDIENCE,
  }) as JwtPayload;
  return {
    userID: typeof payload.sub === "string" ? payload.sub : "",
    email: typeof payload.email === "string" ? payload.email : "",
    // Default false, never true: a token minted before this claim existed, or
    // by a driver that does not set it, must not be read as verified.
    emailVerified: payload.emailVerified === true,
    name: typeof payload.name === "string" ? payload.name : "",
    roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
    ssoProvider: typeof payload.ssoProvider === "string" ? payload.ssoProvider : "",
  };
}
