/**
 * Bearer authentication for /metrics (spec 025 §3.4), separated from
 * obs/api.ts so it can be unit-tested without constructing a raw Encore
 * request, in the same spirit as lib/rate-limit-window.ts.
 *
 * The endpoint remains always-on and unflagged (spec 022's contract): this
 * authenticates it, it does not gate it off. When no token is configured the
 * endpoint serves unauthenticated, which is what npm run dev and the test
 * suite rely on; the packaged image always has one, provisioned by
 * first-boot.mjs.
 */

/** Constant-time compare, so the token is not recoverable byte by byte. */
export function tokenMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** The bearer value, or undefined when the header is absent or malformed. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  // Scheme names are case-insensitive (RFC 9110 §11.1).
  const match = /^Bearer +(.+)$/i.exec(value.trim());
  return match ? match[1]!.trim() : undefined;
}

/**
 * Whether this request may read /metrics. `expected` is the configured
 * token; absent or empty means no authentication is configured.
 */
export function metricsAuthorized(
  header: string | string[] | undefined,
  expected: string | undefined,
): boolean {
  if (expected === undefined || expected === "") return true;
  const presented = bearerToken(header);
  return presented !== undefined && tokenMatches(presented, expected);
}
