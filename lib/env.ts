/**
 * Non-secret runtime configuration, read from process.env in one place.
 *
 * Secret material (JWT keys, the rauthy client secret) is NOT here: it is
 * read through Encore secret() in lib/secrets.ts so it is never logged or
 * committed. Ported from template-encore apps/api (spec 002 there), minus the
 * BFF gateway block enrahitu does not carry.
 */

// `encore run` does not load .env itself; Node can. Values already present in
// the real environment always win (loadEnvFile never overrides existing vars),
// and a missing .env (e.g. the production container) is simply skipped.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env in cwd: configuration comes entirely from the environment
}

function str(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}
function strOr(name: string, fallback: string): string {
  return str(name) ?? fallback;
}
function num(name: string, fallback: number): number {
  const v = str(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = str(name);
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

export type AuthDriver = "mock" | "rauthy";

export const env = {
  get isProduction(): boolean {
    return process.env.NODE_ENV === "production";
  },
  port: num("PORT", 4000),

  authDriver: strOr("AUTH_DRIVER", "mock") as AuthDriver,
  frontendUrl: strOr("FRONTEND_URL", "http://localhost:5173"),
  logPii: bool("LOG_PII", false),

  // rauthy (OIDC) non-secret config; provider metadata is discovered from
  // RAUTHY_ISSUER (.well-known/openid-configuration). In the enrahitu container
  // the issuer is same-origin, served through the idp proxy (Phase 3).
  rauthyIssuer: str("RAUTHY_ISSUER"),
  rauthyClientId: str("RAUTHY_CLIENT_ID"),
  rauthyRedirectUri: strOr(
    "RAUTHY_REDIRECT_URI",
    "http://localhost:4000/api/v1/auth/rauthy/callback",
  ),
  rauthyScopes: strOr("RAUTHY_SCOPES", "openid profile email groups"),
  rauthyDefaultRole: strOr("RAUTHY_DEFAULT_ROLE", "user"),
};
