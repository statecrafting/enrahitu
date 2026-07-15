/**
 * CSRF double-submit protection.
 *
 * State-changing requests must carry an X-CSRF-Token header whose value
 * matches the httpOnly csrf cookie, compared in constant time. SSO callbacks
 * and /auth/refresh are exempt (they cannot carry a prior-issued token). Safe
 * methods (GET/HEAD/OPTIONS/TRACE) are never checked.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

import { APIError, middleware } from "encore.dev/api";

import { CSRF_COOKIE } from "./cookie-config";
import { parseCookies } from "./cookies";
import { logSecurityEvent } from "./logger";

export const CSRF_HEADER = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

// SSO callbacks (.../callback) and the refresh rotation endpoint are exempt.
export const CSRF_EXEMPT_PATTERNS: RegExp[] = [/\/callback$/, /\/auth\/refresh$/];

export function isCsrfExempt(method: string, path: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase()) || CSRF_EXEMPT_PATTERNS.some((re) => re.test(path));
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function headerValue(headers: Record<string, string | string[]>, key: string): string | undefined {
  const v = headers[key] ?? headers[key.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export const csrfMiddleware = middleware(async (req, next) => {
  const meta = req.requestMeta;
  if (meta && meta.type === "api-call" && !isCsrfExempt(meta.method, meta.path)) {
    const headers = meta.headers ?? {};
    const sent = headerValue(headers, CSRF_HEADER);
    const cookies = parseCookies(headerValue(headers, "cookie"));
    const expected = cookies[CSRF_COOKIE];

    if (!sent || !expected) {
      logSecurityEvent("csrf.missing", { path: meta.path, method: meta.method });
      throw APIError.invalidArgument("missing CSRF token").withDetails({ code: "CSRF_MISSING" });
    }
    if (!constantTimeEqual(sent, expected)) {
      logSecurityEvent("csrf.mismatch", { path: meta.path, method: meta.method });
      throw APIError.invalidArgument("CSRF token mismatch").withDetails({ code: "CSRF_MISMATCH" });
    }
  }
  return next(req);
});
