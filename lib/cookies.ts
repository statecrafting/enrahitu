/**
 * Cookie parsing and Set-Cookie serialization for raw endpoints.
 *
 * The cookie/token lifecycle endpoints (login, callbacks, refresh, logout,
 * csrf-token) are api.raw handlers, so they manage cookies on the Node
 * ServerResponse directly via these helpers.
 */
import type { ServerResponse } from "node:http";

import {
  ACCESS_COOKIE,
  ACCESS_TOKEN_MAX_AGE,
  CSRF_COOKIE,
  REFRESH_COOKIE,
  REFRESH_TOKEN_MAX_AGE,
  authCookieOptions,
  type CookieOptions,
} from "./cookie-config";

export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const segments = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path}`];
  if (opts.maxAge !== undefined) {
    segments.push(`Max-Age=${opts.maxAge}`);
    segments.push(`Expires=${new Date(Date.now() + opts.maxAge * 1000).toUTCString()}`);
  }
  segments.push(`SameSite=${opts.sameSite}`);
  if (opts.httpOnly) segments.push("HttpOnly");
  if (opts.secure) segments.push("Secure");
  return segments.join("; ");
}

function appendSetCookie(res: ServerResponse, cookie: string): void {
  const prev = res.getHeader("Set-Cookie");
  const arr = prev === undefined ? [] : Array.isArray(prev) ? prev.map(String) : [String(prev)];
  arr.push(cookie);
  res.setHeader("Set-Cookie", arr);
}

export function setAuthCookies(
  res: ServerResponse,
  tokens: { accessToken: string; refreshToken: string },
): void {
  appendSetCookie(
    res,
    serializeCookie(ACCESS_COOKIE, tokens.accessToken, authCookieOptions(ACCESS_TOKEN_MAX_AGE)),
  );
  appendSetCookie(
    res,
    serializeCookie(REFRESH_COOKIE, tokens.refreshToken, authCookieOptions(REFRESH_TOKEN_MAX_AGE)),
  );
}

export function setCsrfCookie(res: ServerResponse, token: string): void {
  appendSetCookie(res, serializeCookie(CSRF_COOKIE, token, authCookieOptions(ACCESS_TOKEN_MAX_AGE)));
}

export function clearAuthCookies(res: ServerResponse): void {
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE]) {
    appendSetCookie(res, serializeCookie(name, "", authCookieOptions(0)));
  }
}
