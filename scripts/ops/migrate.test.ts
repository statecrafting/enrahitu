/**
 * The `migrate` verb and the operator session it travels on (spec 027 §3.4).
 *
 * The verb owns no migration logic, so what is worth asserting is what it does
 * own: that it covers BOTH stores rather than the one whoever wrote it was
 * thinking about, that it changes nothing without `--apply`, and that the three
 * refusals an operator actually hits are told apart. A verb that printed the
 * status code for all three would leave the operator to guess which of three
 * unrelated fixes applies.
 */
import { describe, expect, it } from "vitest";

import { adminRequest, cookieFrom } from "./admin-plane.mjs";
import { apply, plan, STORES } from "./migrate.mjs";

const session = { ENRAHITU_OPERATOR_COOKIE: "access_token=abc" } as NodeJS.ProcessEnv;

/**
 * A stub plane that records what it was asked and answers per path.
 *
 * It answers the CSRF endpoint too, because an unsafe method is a two-step
 * exchange against the real app: signing in does not issue the csrf cookie, so
 * the verb asks for one exactly as the SPA does (spec 004).
 */
function planeStub(answers: Record<string, unknown>) {
  answers = { "/api/v1/auth/csrf-token": { token: "tok" }, ...answers };
  const seen: { path: string; method: string; headers: Record<string, string> }[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    seen.push({
      path,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    const body = answers[path];
    if (body === undefined) return { ok: false, status: 404 } as Response;
    return { ok: true, status: 200, json: async () => body } as Response;
  };
  return { fetchImpl, seen };
}

describe("migrate: one verb over both stores", () => {
  it("reports each store's pending list without applying anything", async () => {
    const { fetchImpl, seen } = planeStub({
      "/api/admin/schema": { version: 1, pending: [{ version: 2, name: "control plane: leases" }] },
      "/api/admin/ledger/schema": { version: 4, pending: [] },
    });
    const stores = await plan(session, { fetchImpl });
    expect(stores.map((s: { key: string }) => s.key)).toEqual(["state", "ledger"]);
    expect(stores[0].pending).toHaveLength(1);
    expect(stores[1].pending).toHaveLength(0);
    // Nothing was applied: every call was a GET.
    expect(seen.every((call) => call.method === "GET")).toBe(true);
  });

  it("applies both stores and reports what each applied", async () => {
    const { fetchImpl, seen } = planeStub({
      "/api/admin/schema/apply": { version: 2, applied: [{ version: 2, name: "leases" }] },
      "/api/admin/ledger/schema/apply": { version: 4, applied: [] },
    });
    const results = await apply(session, { fetchImpl });
    expect(results[0].applied).toEqual([2]);
    expect(results[1].applied).toEqual([]);
    expect(seen.filter((call) => call.path.endsWith("/apply")).every((c) => c.method === "POST")).toBe(
      true,
    );
  });

  it("acquires a CSRF token the way the SPA does, then sends both halves", async () => {
    // The admin service double-submits: the header must match the cookie. A
    // session alone cannot satisfy that, because signing in does not issue the
    // csrf cookie. Asking for one is the step a hand-assembled header omits.
    const { fetchImpl, seen } = planeStub({
      "/api/admin/schema/apply": { version: 1, applied: [] },
      "/api/admin/ledger/schema/apply": { version: 1, applied: [] },
    });
    await apply(session, { fetchImpl });
    expect(seen[0].path).toBe("/api/v1/auth/csrf-token");
    const post = seen.find((call) => call.path.endsWith("/apply"))!;
    expect(post.headers["x-csrf-token"]).toBe("tok");
    expect(post.headers.cookie).toContain("access_token=abc");
    expect(post.headers.cookie).toContain("csrf_token=tok");
  });

  it("surfaces a concurrent runner's outcome rather than swallowing it", async () => {
    const { fetchImpl } = planeStub({
      "/api/admin/schema/apply": { version: 2, applied: [] },
      "/api/admin/ledger/schema/apply": {
        version: 4,
        applied: [],
        concurrent: "another runner recorded 4 mid-flight; nothing is half-applied",
      },
    });
    const results = await apply(session, { fetchImpl });
    expect(results[1].concurrent).toContain("nothing is half-applied");
  });

  it("names both stores' endpoint pairs, so neither can be forgotten", () => {
    expect(STORES.map((s) => s.apply)).toEqual([
      "/api/admin/schema/apply",
      "/api/admin/ledger/schema/apply",
    ]);
  });
});

describe("the operator session", () => {
  it("refuses without one, naming what to set", async () => {
    await expect(adminRequest({} as NodeJS.ProcessEnv, "/api/admin/schema")).rejects.toThrow(
      /ENRAHITU_OPERATOR_COOKIE/,
    );
  });

  it("tells the three refusals apart, because each has a different fix", async () => {
    const answer = (status: number) => async () => ({ ok: false, status }) as Response;
    const cases: [number, RegExp][] = [
      [404, /admin plane is off/],
      [401, /session is not valid/],
      [403, /does not carry the operator role/],
    ];
    for (const [status, message] of cases) {
      await expect(
        adminRequest(session, "/api/admin/schema", { fetchImpl: answer(status) }),
      ).rejects.toThrow(message);
    }
  });

  it("reads a cookie through a deployment's prefix", () => {
    // Under https the cookie is __Host- prefixed, so a verb that only knew the
    // bare name would fail on exactly the deployments configured correctly.
    expect(cookieFrom("__Host-csrf_token=abc; other=1", "csrf_token")).toBe("abc");
    expect(cookieFrom(["csrf_token=xyz; Path=/; HttpOnly"], "csrf_token")).toBe("xyz");
    expect(cookieFrom("access_token=only", "csrf_token")).toBeUndefined();
  });

  it("says the session expired when the token endpoint refuses", async () => {
    // The failure an operator actually hits: an access token lives 15 minutes,
    // so a cookie captured earlier in a session is the common cause of a POST
    // that cannot be signed.
    const fetchImpl = async () => ({ ok: false, status: 401 }) as Response;
    await expect(
      adminRequest(session, "/api/admin/schema/apply", { method: "POST", fetchImpl }),
    ).rejects.toThrow(/lives 15 minutes/);
  });
});
