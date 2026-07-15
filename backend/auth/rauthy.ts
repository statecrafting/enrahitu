/**
 * rauthy (OIDC) driver built on openid-client v6 (authorization code + PKCE).
 * The issuer is discovered from RAUTHY_ISSUER (.well-known/openid-configuration),
 * so no provider URLs are hard-coded; in the enrahitu topology the issuer is this
 * app's own origin, served through the idp proxy (idp/proxy.ts). Stateless:
 * the state, PKCE verifier, and nonce ride a short-lived httpOnly cookie
 * across the redirect. Config-gated: unavailable unless issuer, client id,
 * and secret are set.
 *
 * rauthy emits `roles` on every token and `groups` when the `groups` scope is
 * requested, so roles are taken first, then groups, then RAUTHY_DEFAULT_ROLE.
 */
import { api } from "encore.dev/api";
import * as client from "openid-client";

import { authCookieOptions } from "../lib/cookie-config";
import { parseCookies, serializeCookie } from "../lib/cookies";
import { env } from "../lib/env";
import { withinAuthRateLimit } from "../lib/rate-limit";
import { rauthyClientSecretValue } from "../lib/secrets";

import { clientIp, redirect, requestUrl, userAgent } from "./http";
import { finalizeLogin, frontendUrl } from "./service";
import type { SSOProfile } from "./types";

const OIDC_TX_COOKIE = "oidc_tx";

export function isRauthyConfigured(): boolean {
  return Boolean(env.rauthyIssuer && env.rauthyClientId && rauthyClientSecretValue());
}

function getConfig(): Promise<client.Configuration> {
  const issuer = new URL(env.rauthyIssuer!);
  // Local development runs the whole loop over plain http on one origin;
  // openid-client refuses http unless explicitly allowed.
  const execute = issuer.protocol === "http:" ? [client.allowInsecureRequests] : [];
  return client.discovery(issuer, env.rauthyClientId!, rauthyClientSecretValue(), undefined, {
    execute,
  });
}

function profileFromClaims(claims: Record<string, unknown>): SSOProfile {
  const rolesClaim = claims["roles"] ?? claims["groups"];
  const roles = Array.isArray(rolesClaim)
    ? (rolesClaim as unknown[]).map(String)
    : [env.rauthyDefaultRole];
  const email = (claims["email"] as string) ?? (claims["preferred_username"] as string) ?? "";
  const name = (claims["name"] as string) ?? email;
  return {
    ssoProvider: "rauthy",
    ssoProviderId: (claims["sub"] as string) ?? "",
    email,
    name,
    roles: roles.length ? roles : [env.rauthyDefaultRole],
  };
}

export const rauthyLogin = api.raw(
  { expose: true, method: "GET", path: "/api/v1/auth/rauthy/login" },
  async (req, res) => {
    if (!isRauthyConfigured()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (!(await withinAuthRateLimit(clientIp(req)))) {
      res.statusCode = 429;
      res.setHeader("Retry-After", "60");
      res.end("rate limit exceeded");
      return;
    }
    const config = await getConfig();
    const verifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(verifier);
    const state = client.randomState();
    const nonce = client.randomNonce();

    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: env.rauthyRedirectUri,
      scope: env.rauthyScopes,
      response_type: "code",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    const tx = Buffer.from(JSON.stringify({ state, verifier, nonce })).toString("base64url");
    res.setHeader("Set-Cookie", serializeCookie(OIDC_TX_COOKIE, tx, authCookieOptions(600)));
    redirect(res, url.href);
  },
);

export const rauthyCallback = api.raw(
  { expose: true, method: "GET", path: "/api/v1/auth/rauthy/callback" },
  async (req, res) => {
    if (!isRauthyConfigured()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (!(await withinAuthRateLimit(clientIp(req)))) {
      res.statusCode = 429;
      res.setHeader("Retry-After", "60");
      res.end("rate limit exceeded");
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    const txRaw = cookies[OIDC_TX_COOKIE];
    if (!txRaw) {
      res.statusCode = 400;
      res.end("missing login transaction");
      return;
    }
    const { state, verifier, nonce } = JSON.parse(
      Buffer.from(txRaw, "base64url").toString("utf8"),
    ) as { state: string; verifier: string; nonce: string };

    const config = await getConfig();
    const currentUrl = new URL(env.rauthyRedirectUri);
    currentUrl.search = requestUrl(req).search;

    const tokens = await client.authorizationCodeGrant(config, currentUrl, {
      expectedState: state,
      pkceCodeVerifier: verifier,
      expectedNonce: nonce,
    });
    const claims = tokens.claims();
    if (!claims) {
      res.statusCode = 401;
      res.end("no id token");
      return;
    }

    // Clear the transaction cookie, then finalize (which appends the auth cookies).
    res.setHeader("Set-Cookie", serializeCookie(OIDC_TX_COOKIE, "", authCookieOptions(0)));
    const profile = profileFromClaims(claims as unknown as Record<string, unknown>);
    await finalizeLogin(res, profile, { ipAddress: clientIp(req), userAgent: userAgent(req) });
    redirect(res, frontendUrl("/"));
  },
);
