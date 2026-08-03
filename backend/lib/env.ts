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

  // The admin dashboard runtime kill switch (spec 023 §3.1): false serves
  // 404 on /admin and /api/admin/* even where the stamp kept the slot.
  adminUiEnabled: bool("ADMIN_UI_ENABLED", true),

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

  // Application mail (spec 037 §3.1). A SEPARATE surface from ENRAHITU_SMTP_*,
  // which is rauthy's alone and is scoped into the rauthy subshell by the
  // entrypoint (spec 026 §3.1). Pointing this feature at those variables would
  // have required un-scoping them, dismantling the invariant spec 026 exists to
  // establish, and would have done it silently. Two surfaces, two holders, and
  // the blast radius of a leaked credential stays the size of what leaked.
  //
  // `none` is the default and is not a testing convenience: a deployment that
  // has configured no mail must boot, and must not pretend to send.
  mailTransport: strOr("ENRAHITU_MAIL_TRANSPORT", "none"),
  mailFrom: str("ENRAHITU_MAIL_FROM"),
  mailRelayHost: strOr("ENRAHITU_MAIL_HOST", "localhost"),
  mailRelayPort: num("ENRAHITU_MAIL_PORT", 25),
  mailUser: str("ENRAHITU_MAIL_USER"),
  // Plaintext with no STARTTLS. True only for a catcher on a private network
  // (the dev topology's Mailpit); anywhere else this sends credentials and
  // member data in the clear.
  mailInsecure: bool("ENRAHITU_MAIL_DANGER_INSECURE", false),
};
