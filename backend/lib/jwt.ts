/**
 * RS256 JWT issuance and verification.
 *
 * Access tokens are short-lived (15 min). Refresh tokens are long-lived
 * (7 day) but only meaningful when their SHA-256 hash is present and
 * unrevoked in the refresh_token table; this module mints and verifies the
 * signature, while rotation and revocation live in auth/refresh-token-model.ts.
 */
import { createHash, randomUUID } from "node:crypto";

import jwt from "jsonwebtoken";
import type { JwtPayload } from "jsonwebtoken";

import {
  accessPrivateKey,
  accessPublicKey,
  refreshPrivateKey,
  refreshPublicKey,
} from "./secrets";

const ISSUER = "enrahitu";
const AUDIENCE = "enrahitu-spa";
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface AccessTokenClaims {
  userID: string;
  email: string;
  name: string;
  roles: string[];
  ssoProvider: string;
}

export interface RefreshTokenClaims {
  userID: string;
  jti: string;
}

export interface SignedRefreshToken {
  token: string;
  jti: string;
  expiresAt: Date;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return jwt.sign(
    {
      email: claims.email,
      name: claims.name,
      roles: claims.roles,
      ssoProvider: claims.ssoProvider,
    },
    accessPrivateKey(),
    {
      algorithm: "RS256",
      subject: claims.userID,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: ACCESS_TTL_SECONDS,
    },
  );
}

export async function signRefreshToken(userID: string): Promise<SignedRefreshToken> {
  const jti = randomUUID();
  const token = jwt.sign({}, refreshPrivateKey(), {
    algorithm: "RS256",
    subject: userID,
    jwtid: jti,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: REFRESH_TTL_SECONDS,
  });
  return { token, jti, expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000) };
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

export async function verifyRefreshToken(token: string): Promise<RefreshTokenClaims> {
  const payload = jwt.verify(token, refreshPublicKey(), {
    algorithms: ["RS256"],
    issuer: ISSUER,
    audience: AUDIENCE,
  }) as JwtPayload;
  return {
    userID: typeof payload.sub === "string" ? payload.sub : "",
    jti: typeof payload.jti === "string" ? payload.jti : "",
  };
}

/** Distinguishes an expired access token so the handler can surface TOKEN_EXPIRED. */
export function isTokenExpiredError(err: unknown): boolean {
  return err instanceof jwt.TokenExpiredError;
}

/** Only the SHA-256 hash of a refresh token is ever persisted. */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
