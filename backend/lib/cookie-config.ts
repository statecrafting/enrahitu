/**
 * Cookie names and default options.
 *
 * Access, refresh, and CSRF cookies are all httpOnly + sameSite=lax, and
 * secure whenever the public origin is https. The scheme (not NODE_ENV) is
 * the signal: a production-mode container served over plain http (a local
 * trial of the packaged image) must not mark cookies Secure, because Safari
 * drops Secure cookies on http even for localhost, silently breaking login.
 * No token is readable from JavaScript; the CSRF token is also delivered in
 * the csrf-token response body so the SPA can replay it as a header
 * (double-submit).
 */
import { env } from "./env";

export const ACCESS_COOKIE = "access_token";
export const REFRESH_COOKIE = "refresh_token";
export const CSRF_COOKIE = "csrf_token";
/** The RP-initiated logout hint, set and owned by the rauthy driver (spec 005). */
export const OIDC_ID_HINT_COOKIE = "oidc_id_hint";

export const ACCESS_TOKEN_MAX_AGE = 15 * 60;
export const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60;

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
  path: string;
  maxAge?: number;
}

export function authCookieOptions(maxAge?: number): CookieOptions {
  return {
    httpOnly: true,
    secure: env.frontendUrl.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    maxAge,
  };
}

/**
 * The id-hint cookie rides only the auth surface: path-scoping keeps its
 * weight (roughly one RS256 id token) off every other request (spec 005).
 */
export function idHintCookieOptions(maxAge?: number): CookieOptions {
  return { ...authCookieOptions(maxAge), path: "/api/v1/auth" };
}
