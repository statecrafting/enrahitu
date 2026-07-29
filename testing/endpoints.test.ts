/**
 * Endpoint-level acceptance against a running gateway (spec 033).
 *
 * These are the first tests in this repo that make a real HTTP request to a
 * real Encore router. They exist to close the acceptance items spec 025 §5
 * could not prove, and to be the harness specs 026 and 027 build on.
 *
 * One instance for the whole file: boot costs several seconds, dominated by the
 * hiqlite raft election.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isAppBuilt, startApp, type AppInstance } from "./app-harness";

// Without `npm run build:app` there is no bundle to boot. CI always builds
// first (verify.yml); a developer running bare `npm test` may not have, and a
// skip with a reason beats a failure that looks like a broken app.
const built = isAppBuilt();
const suite = built ? describe : describe.skip;

if (!built) {
  console.warn("[app-level] skipped: no .encore/build; run `npm run build:app` first");
}

suite("app-level: the running gateway", () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = await startApp();
  }, 90_000);

  afterAll(async () => {
    await app?.stop();
  });

  describe("health probes (spec 025 §3.3)", () => {
    it("serves /healthz as liveness", async () => {
      const res = await app.fetch("/healthz");
      expect(res.status).toBe(200);
    });

    // The split is the point: /healthz must not consult the ledger, because a
    // transient ledger blip that restarts the container also takes rauthy down
    // with it under the die-together supervisor.
    it("serves /readyz as readiness", async () => {
      const res = await app.fetch("/readyz");
      expect(res.status).toBe(200);
    });
  });

  describe("/metrics authentication (spec 025 acceptance 6)", () => {
    it("refuses an unauthenticated scrape", async () => {
      const res = await app.fetch("/metrics");
      expect(res.status).toBe(401);
    });

    it("refuses a wrong bearer token", async () => {
      const res = await app.fetch("/metrics", {
        headers: { authorization: "Bearer definitely-not-the-token" },
      });
      expect(res.status).toBe(401);
    });

    it("serves Prometheus text to a correct bearer token", async () => {
      const res = await app.fetch("/metrics", {
        headers: { authorization: `Bearer ${app.metricsToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      // Prometheus exposition format, not JSON: HELP/TYPE preamble lines.
      expect(body).toMatch(/^# HELP /m);
      expect(body).toMatch(/^# TYPE /m);
    });
  });

  /**
   * Spec 025 acceptance items 1 and 4 asked for proof that an unauthenticated
   * POST /hiq/kv is refused and that a non-`demo:` key is denied with
   * KERNEL_DENIED. Spec 015 retired those endpoints entirely, so the items are
   * satisfied by a stronger property than the one they asked for: the surface
   * does not exist, and the service that held the grants holds none.
   *
   * Asserting the absence rather than deleting the requirement is deliberate.
   * A future change that reintroduces a write surface on this service fails
   * here, which is where the spec 025 exploit path would otherwise reopen.
   */
  describe("the hiq HTTP demo is gone (spec 015)", () => {
    it.each([
      ["POST", "/hiq/kv"],
      ["GET", "/hiq/kv/demo:x"],
      ["DELETE", "/hiq/kv/demo:x"],
      ["POST", "/hiq/counter/demo:x/add"],
      ["GET", "/hiq/counter/demo:x"],
    ])("%s %s is not routed", async (method, path) => {
      const res = await app.fetch(path, { method });
      expect(res.status).toBe(404);
    });

    it("keeps GET /hiq/health public", async () => {
      const res = await app.fetch("/hiq/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(typeof body.status).toBe("string");
    });
  });

  describe("session lifecycle (spec 004, mock driver)", () => {
    it("reports the configured drivers", async () => {
      const res = await app.fetch("/api/v1/auth/status");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authenticated: boolean; drivers: string[] };
      expect(body.authenticated).toBe(false);
      expect(body.drivers).toContain("mock");
    });

    it("refuses /me without a session", async () => {
      const res = await app.fetch("/api/v1/auth/me");
      expect(res.status).toBe(401);
    });

    it("signs in, serves the profile, and signs out", async () => {
      const login = await app.fetch("/api/v1/auth/mock/login?user=0");
      // The driver redirects into the SPA once the session cookies are set.
      expect([200, 302, 303, 307]).toContain(login.status);

      const me = await app.fetch("/api/v1/auth/me");
      expect(me.status).toBe(200);
      const profile = (await me.json()) as { email: string; roles: string[] };
      expect(profile.email).toBeTruthy();
      expect(Array.isArray(profile.roles)).toBe(true);

      const out = await app.fetchWithCsrf("/api/v1/auth/logout", { method: "POST" });
      expect(out.status).toBe(200);

      const after = await app.fetch("/api/v1/auth/me");
      expect(after.status).toBe(401);
    });

    // Double-submit CSRF (spec 004): a state-changing request without the
    // header is refused even when the session cookie is valid. This is the
    // assertion that a unit test of the middleware cannot make, because it
    // depends on the cookie and the header travelling together over the wire.
    //
    // 400 rather than 403: the middleware raises APIError.invalidArgument with
    // a CSRF_MISSING detail code. Asserting the detail code as well as the
    // status is what makes this a test of the CSRF gate specifically, rather
    // than of "some rejection happened".
    it("refuses a state-changing request without the CSRF header", async () => {
      await app.fetch("/api/v1/auth/mock/login?user=0");
      const res = await app.fetch("/api/v1/auth/logout", { method: "POST" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { details?: { code?: string } };
      expect(body.details?.code).toBe("CSRF_MISSING");
      // The session survived the refusal: the request was rejected, not the user.
      const me = await app.fetch("/api/v1/auth/me");
      expect(me.status).toBe(200);
    });
  });

  describe("security headers (spec 004)", () => {
    it("sets them on an API response", async () => {
      const res = await app.fetch("/api/v1/auth/status");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBeTruthy();
    });
  });
});

/**
 * The mock driver is development-only, and until now nothing proved it.
 * `isMockEnabled()` is `!env.isProduction`, so a production build that
 * accidentally kept the mock route would hand anyone an admin session by
 * visiting a URL. That is a one-line regression away at all times and it is
 * exactly the class of defect the spec 025 exposure review found elsewhere.
 *
 * Its own instance, because it needs NODE_ENV=production for the whole process.
 */
suite("app-level: production mode disables the mock driver", () => {
  let prod: AppInstance;

  beforeAll(async () => {
    prod = await startApp({ env: { NODE_ENV: "production" } });
  }, 90_000);

  afterAll(async () => {
    await prod?.stop();
  });

  it("does not advertise the mock driver", async () => {
    const res = await prod.fetch("/api/v1/auth/status");
    const body = (await res.json()) as { drivers: string[] };
    expect(body.drivers).not.toContain("mock");
  });

  it("refuses the mock login route", async () => {
    const res = await prod.fetch("/api/v1/auth/mock/login?user=1");
    expect(res.status).toBe(404);
    // And no session was minted on the way to refusing.
    const me = await prod.fetch("/api/v1/auth/me");
    expect(me.status).toBe(401);
  });
});
