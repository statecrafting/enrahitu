/**
 * Security response headers applied as Encore middleware: CSP, HSTS, and
 * Permissions-Policy among others. Mounted on the health and auth services.
 * The web (static) service deliberately omits this middleware so hashed
 * bundles cache normally.
 */
import { middleware } from "encore.dev/api";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
].join("; ");

const HEADERS: Record<string, string> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  "Cache-Control": "no-store",
};

export const securityHeaders = middleware(async (req, next) => {
  const raw = req.rawResponse;
  if (raw) {
    // Raw endpoints write their own response; set headers on the
    // ServerResponse before the handler body runs.
    for (const [key, value] of Object.entries(HEADERS)) raw.setHeader(key, value);
    return next(req);
  }
  const resp = await next(req);
  for (const [key, value] of Object.entries(HEADERS)) resp.header.set(key, value);
  return resp;
});
