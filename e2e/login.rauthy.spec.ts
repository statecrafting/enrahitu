// spec 017: end-to-end rauthy login validation (browser-real).
//
// Proves the whole authentication topology survives change: SPA -> same-origin
// /auth/* proxy (spec 005) -> rauthy login UI -> OIDC callback -> app session
// cookie. Unit tests cover token/cookie mechanics; only this proves the proxy
// path rewriting, rauthy redirects, and single-origin cookie scoping hold
// together in a real browser engine.
//
// PREREQUISITES (from a clean checkout):
//   npm ci && npm --prefix frontend ci
//   npm run build:app          # app bundle + meta (.encore/build)
//   npm run build:web          # the SPA into backend/web/dist (served at :4000)
//   npx playwright install chromium
//   docker running (globalSetup runs `npm run dev:idp`: compose + secret sync)
//
// RUN:  npm run test:e2e
//   globalSetup boots dev rauthy and syncs keys/rauthy-client-secret; the
//   webServer boots `npm run dev` on :4000 with the rauthy driver enabled
//   (see e2e/playwright.config.ts). Nothing here talks to rauthy directly:
//   every request goes through the app origin.
//
// TEST USER: the DEV_MODE-seeded rauthy admin (docker/rauthy: admin@localhost /
//   123SuperSafe). Override with E2E_RAUTHY_USER / E2E_RAUTHY_PASS to point at
//   a dedicated user provisioned through the rauthy admin UI.
//
// PROVING IT ACTUALLY EXERCISES THE TOPOLOGY (spec 017 section 4): break the
//   proxy and this test must fail with a diagnosable trace, not pass hollowly.
//   e.g. start the app with RAUTHY_ISSUER pointed off-origin (edit the
//   webServer env in playwright.config.ts to `http://127.0.0.1:8081/auth/v1`):
//   the browser then leaves the app origin, the off-origin assertion below
//   trips, and the retained trace shows the escaped request.
import { expect, test } from "@playwright/test";

const RAUTHY_USER = process.env.E2E_RAUTHY_USER ?? "admin@localhost";
const RAUTHY_PASS = process.env.E2E_RAUTHY_PASS ?? "123SuperSafe";

test("rauthy password login round-trip stays on the app origin", async ({
  page,
  context,
  baseURL,
}) => {
  const appOrigin = new URL(baseURL!).origin; // http://localhost:4000

  // Record any request whose origin is not the app origin. rauthy's login UI
  // and its assets are all served through the /auth/* proxy, so a correctly
  // wired topology never leaves :4000. data:/about: and non-http are ignored.
  const offOrigin: string[] = [];
  page.on("request", (req) => {
    let u: URL;
    try {
      u = new URL(req.url());
    } catch {
      return;
    }
    if (!u.protocol.startsWith("http")) return;
    if (u.origin !== appOrigin) offOrigin.push(req.url());
  });

  // 1. Land on the SPA and start the rauthy login. The link renders only once
  //    GET /api/v1/auth/status reports the rauthy driver, so auto-waiting on
  //    visibility also proves the app is configured for rauthy.
  await page.goto("/");
  const signIn = page.getByRole("link", { name: /sign in with rauthy/i });
  await expect(signIn).toBeVisible();
  await signIn.click();

  // 2. rauthy's login form, served same-origin under /auth/v1/oidc/authorize.
  //    Wait for its SPA to load AND hydrate before touching it: the submit is
  //    a client-side JSON fetch, and clicking before the onsubmit handler is
  //    attached fires a NATIVE urlencoded form POST that rauthy rejects with
  //    "Content type error" (observed on slower CI runners). networkidle is
  //    the practical hydration signal: the JS bundle has loaded and its
  //    initial fetches (incl. the proof-of-work challenge) have settled.
  await page.waitForURL(/\/auth\/v1\/oidc\/authorize/);
  await page.waitForLoadState("networkidle");
  const email = page.locator('input[name="email"]');
  await expect(email).toBeVisible();
  await email.fill(RAUTHY_USER);

  //    Deliberate TWO-STEP form (anti-autofill): submit email first, the
  //    password field then appears (via a fetch round-trip, no navigation),
  //    submit again. A one-shot fill-both would no-op on the first submit.
  await page.getByRole("button", { name: "Login" }).click();
  const password = page.locator('input[name="password"]');
  await expect(password).toBeVisible({ timeout: 20_000 });
  await password.fill(RAUTHY_PASS);
  await page.getByRole("button", { name: "Login" }).click();

  // 3. Back on the app, authenticated: the callback 302s to FRONTEND_URL + "/".
  await page.waitForURL(`${appOrigin}/`);

  // The callback set both session cookies (spec 004).
  const cookies = await context.cookies();
  const names = cookies.map((c) => c.name);
  expect(names).toContain("access_token");
  expect(names).toContain("refresh_token");

  // 4. The profile identity comes from GET /api/v1/auth/me.
  const me = await page.request.get("/api/v1/auth/me");
  expect(me.status()).toBe(200);
  expect((await me.json()).email).toBe(RAUTHY_USER);
  // The SPA has left the signed-out state.
  await expect(signIn).toHaveCount(0);

  // 5. Logout requires the CSRF header (double-submit): fetch the token, then
  //    POST it. A headerless logout is a 400 by design (spec 004), so this also
  //    guards that the CSRF path is wired.
  const csrf = await (await page.request.get("/api/v1/auth/csrf-token")).json();
  const loggedOut = await page.request.post("/api/v1/auth/logout", {
    headers: { "x-csrf-token": csrf.token },
  });
  expect(loggedOut.ok()).toBeTruthy();

  // RP-initiated logout (spec 005): the response hands back the same-origin
  // end-session URL carrying the id-token hint. Asserted by API inspection,
  // deliberately not navigated: the wire fact without new flake surface.
  const { redirectUrl } = (await loggedOut.json()) as { redirectUrl: string };
  expect(redirectUrl).toContain("/auth/v1/oidc/logout");
  expect(redirectUrl).toContain("id_token_hint=");

  // Session is gone: /me is now unauthenticated.
  expect((await page.request.get("/api/v1/auth/me")).status()).toBe(401);

  // 6. The whole round-trip stayed on one origin.
  expect(offOrigin, `requests left the app origin: ${offOrigin.join(", ")}`).toEqual([]);
});
