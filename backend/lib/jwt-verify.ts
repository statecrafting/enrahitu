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
    name: typeof payload.name === "string" ? payload.name : "",
    roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
    ssoProvider: typeof payload.ssoProvider === "string" ? payload.ssoProvider : "",
  };
}
