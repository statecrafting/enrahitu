/**
 * The dual-mode authHandler and the Gateway that binds it.
 *
 * Credentials are read from the Authorization: Bearer header first, then the
 * httpOnly access_token cookie (the SPA's primary path). An expired access
 * token surfaces a typed TOKEN_EXPIRED detail so the client can trigger
 * silent refresh.
 *
 * All logging here routes through lib/logger.ts (PII redaction); never log
 * raw tokens, cookies, or claims from this handler.
 */
import { APIError, Gateway, type Cookie, type Header } from "encore.dev/api";
import { authHandler } from "encore.dev/auth";

import { runAsService } from "../kernel/adjudicate";
import { isTokenExpiredError, verifyAccessToken } from "../lib/jwt";

import type { AuthData } from "./types";

interface AuthParams {
  authorization?: Header<"Authorization">;
  session?: Cookie<"access_token">;
}

function extractToken(params: AuthParams): string | undefined {
  const bearer = params.authorization;
  if (bearer && bearer.toLowerCase().startsWith("bearer ")) {
    return bearer.slice(7).trim();
  }
  return params.session?.value;
}

// The handler body runs before endpoint request context exists, so its
// kernel attribution (the JWT public-key secret.read) is pinned to this
// handler's home service explicitly (spec 021 §3.5).
export const auth = authHandler<AuthParams, AuthData>(async (params) =>
  runAsService("auth", async () => {
    const token = extractToken(params);
    if (!token) {
      throw APIError.unauthenticated("missing authentication credentials");
    }
    try {
      const claims = await verifyAccessToken(token);
      return {
        userID: claims.userID,
        email: claims.email,
        name: claims.name,
        roles: claims.roles,
        ssoProvider: claims.ssoProvider,
      };
    } catch (err) {
      if (isTokenExpiredError(err)) {
        throw APIError.unauthenticated("access token expired").withDetails({
          code: "TOKEN_EXPIRED",
        });
      }
      throw APIError.unauthenticated("invalid access token");
    }
  }),
);

export const gateway = new Gateway({ authHandler: auth });
