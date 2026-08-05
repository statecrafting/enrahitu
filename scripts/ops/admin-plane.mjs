/**
 * The operator session a verb uses to reach the admin data plane
 * (spec 027 §3.2, §3.4).
 *
 * Two verbs need it, for the same reason stated once: at N=1 the app's embedded
 * hiqlite node holds the volume open, so an operation on that store is performed
 * BY the running app under an authenticated operator. `migrate` needs it for
 * both schema pairs and `backup --online` for the resource store's snapshot.
 *
 * ## Why a cookie rather than a token
 *
 * There is no operator API token in this substrate and inventing one here would
 * be a second credential surface for the same principal, which is the shape spec
 * 037 §3.1 argues against. The admin plane authenticates the session cookie the
 * dashboard already uses, gated on the operator role, so a verb presents that
 * session and is adjudicated as the operator who owns it. The act lands on the
 * Decision chain naming a principal rather than a machine account nobody can
 * attribute.
 *
 * `ENRAHITU_OPERATOR_COOKIE` is the `Cookie` header of an authenticated operator
 * session: at minimum `access_token=...`.
 *
 * ## A session is not enough for an unsafe method, and that is by design
 *
 * §3.2 asks for "an operator session for the app", which reads as one
 * credential. It is one credential and two steps. The admin service mounts
 * `csrfMiddleware`, which double-submits: an unsafe method must carry
 * `X-CSRF-Token` matching the httpOnly `csrf_token` cookie. Signing in does not
 * issue that cookie. `GET /api/v1/auth/csrf-token` does, returning the token in
 * the body and setting the cookie, so the SPA can replay one as the header
 * (spec 004).
 *
 * So a verb does exactly what the SPA does rather than asking an operator to
 * assemble a header by hand: it presents the session, asks for a token, and
 * sends both. Requiring the operator to paste a pre-fetched `csrf_token` would
 * be a second credential for the same principal and would break the moment the
 * token expired, which is 15 minutes.
 */

export const DEFAULT_APP_URL = "http://127.0.0.1:8080";

/** The csrf cookie's name, matching `backend/lib/cookie-config.ts`. */
export const CSRF_COOKIE = "csrf_token";

/**
 * Read a cookie out of a `Set-Cookie` header list or a `Cookie` header.
 *
 * Tolerates the `__Host-`/`__Secure-` prefixes a correctly configured https
 * deployment adds, because a verb that only knew the bare name would fail on
 * exactly the deployments that are configured properly.
 */
export function cookieFrom(source, name) {
  const parts = Array.isArray(source) ? source : String(source ?? "").split(";");
  for (const part of parts) {
    const [rawName, ...rest] = String(part).split(";")[0].trim().split("=");
    if (rawName.replace(/^__(Host|Secure)-/, "") === name) return rest.join("=");
  }
  return undefined;
}

export function appUrl(env) {
  return (env.ENRAHITU_APP_URL || DEFAULT_APP_URL).replace(/\/$/, "");
}

/**
 * One request to the admin plane, with the failures named rather than surfaced
 * as a status code.
 *
 * The three that actually happen each have a different fix, and a verb that
 * printed "403" for all of them would leave the operator to guess which: the
 * dashboard's kill switch answers 404 (off is indistinguishable from a stamp
 * without the slot, by design), a session without the operator role answers 403,
 * and an expired session answers 401.
 */
/**
 * Obtain a CSRF token the way the SPA does, and return the cookie header to
 * send with it.
 *
 * The token travels twice: in the header the middleware compares, and in the
 * cookie it compares against. Both come from this one call, so they cannot
 * disagree, which is the failure a hand-assembled header produces most often.
 */
export async function acquireCsrf(env, cookie, fetchImpl = fetch) {
  const res = await fetchImpl(`${appUrl(env)}/api/v1/auth/csrf-token`, {
    method: "GET",
    headers: { cookie, accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `could not obtain a CSRF token (${res.status}). The session in ENRAHITU_OPERATOR_COOKIE is ` +
        `probably expired: an access token lives 15 minutes.`,
    );
  }
  const body = await res.json();
  const setCookie = res.headers?.getSetCookie?.() ?? [];
  const issued = cookieFrom(setCookie, CSRF_COOKIE);
  const token = body.token ?? issued;
  if (!token) throw new Error("the CSRF endpoint issued no token");
  // Send the cookie the endpoint just set alongside the caller's session, so
  // the double-submit compares a pair this verb actually holds.
  const merged = cookieFrom(cookie, CSRF_COOKIE)
    ? cookie
    : `${cookie}; ${CSRF_COOKIE}=${issued ?? token}`;
  return { token, cookie: merged };
}

export async function adminRequest(env, path, { method = "GET", fetchImpl = fetch } = {}) {
  const cookie = env.ENRAHITU_OPERATOR_COOKIE;
  if (!cookie) {
    throw new Error(
      "no operator session: set ENRAHITU_OPERATOR_COOKIE to the Cookie header of a signed-in " +
        "operator. This plane authenticates a principal rather than a machine account, so the " +
        "act is recorded against whoever performed it.",
    );
  }
  const headers = { cookie, accept: "application/json" };
  if (method !== "GET") {
    const { token, cookie: withCsrf } = await acquireCsrf(env, cookie, fetchImpl);
    headers["x-csrf-token"] = token;
    headers.cookie = withCsrf;
    headers["content-type"] = "application/json";
  }
  const res = await fetchImpl(`${appUrl(env)}${path}`, { method, headers });
  if (res.status === 404) {
    throw new Error(
      `${path} answered 404. The admin plane is off (ADMIN_UI_ENABLED=false), or this app was ` +
        `stamped with the admin slot pruned.`,
    );
  }
  if (res.status === 401) throw new Error(`${path} answered 401: the session is not valid.`);
  if (res.status === 403) {
    throw new Error(`${path} answered 403: the session is valid but does not carry the operator role.`);
  }
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}
