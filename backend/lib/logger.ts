/**
 * Structured logging with a PII guard.
 *
 * PII is never written to the log stream. LOG_PII is a development-only
 * escape hatch and is refused in production: the module throws at load time
 * if LOG_PII is true while NODE_ENV is production. Durable audit records
 * (which do carry actor identity) go to the audit_log table via lib/audit.ts,
 * not here.
 */
import * as log from "encore.dev/log";

import { env } from "./env";

if (env.isProduction && env.logPii) {
  throw new Error("LOG_PII must be false in production");
}

// Normalized (lowercased, separators stripped) keys whose values are redacted.
const PII_KEYS = new Set([
  "email",
  "name",
  "password",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "cookie",
  "setcookie",
  "ip",
  "ipaddress",
  "useragent",
  "attributes",
  "assertion",
  "code",
]);

type Fields = Record<string, unknown>;

function normalize(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

export function redact(fields?: Fields): Fields | undefined {
  if (!fields || env.logPii) return fields;
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = PII_KEYS.has(normalize(k)) ? "[redacted]" : v;
  }
  return out;
}

export function logInfo(message: string, fields?: Fields): void {
  log.info(message, redact(fields));
}
export function logWarn(message: string, fields?: Fields): void {
  log.warn(message, redact(fields));
}
export function logError(message: string, fields?: Fields): void {
  log.error(message, redact(fields));
}

// A dedicated channel for security-relevant events (login, csrf, rate
// limiting). Fields are redacted exactly like ordinary logs.
export function logSecurityEvent(event: string, fields?: Fields): void {
  log.info(`security.${event}`, redact(fields));
}
