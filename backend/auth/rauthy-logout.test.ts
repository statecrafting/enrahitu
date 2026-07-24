/**
 * RP-initiated logout proofs (spec 005, amendment 2026-07-23): the
 * end-session URL shape and the id-hint cookie's path scoping. The URL
 * builder is pure construction over env, so the proofs need no rauthy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { OIDC_ID_HINT_COOKIE, idHintCookieOptions } from "../lib/cookie-config";
import { serializeCookie } from "../lib/cookies";

const ISSUER = "http://localhost:4000/auth/v1/";

async function rauthyWithEnv(issuer: string): Promise<typeof import("./rauthy")> {
  vi.resetModules();
  process.env.RAUTHY_ISSUER = issuer;
  process.env.RAUTHY_CLIENT_ID = "enrahitu";
  return import("./rauthy");
}

const savedIssuer = process.env.RAUTHY_ISSUER;
const savedClientId = process.env.RAUTHY_CLIENT_ID;

afterEach(() => {
  if (savedIssuer === undefined) delete process.env.RAUTHY_ISSUER;
  else process.env.RAUTHY_ISSUER = savedIssuer;
  if (savedClientId === undefined) delete process.env.RAUTHY_CLIENT_ID;
  else process.env.RAUTHY_CLIENT_ID = savedClientId;
  vi.resetModules();
});

describe("the end-session URL (spec 005)", () => {
  it("targets the issuer's oidc/logout with hint and registered landing", async () => {
    const mod = await rauthyWithEnv(ISSUER);
    const url = new URL(mod.rauthyEndSessionUrl("header.payload.sig"));
    expect(url.origin).toBe("http://localhost:4000");
    expect(url.pathname).toBe("/auth/v1/oidc/logout");
    expect(url.searchParams.get("id_token_hint")).toBe("header.payload.sig");
    const landing = url.searchParams.get("post_logout_redirect_uri");
    expect(landing).toMatch(/\/$/);
  });

  it("tolerates an issuer without the trailing slash", async () => {
    const mod = await rauthyWithEnv("http://localhost:4000/auth/v1");
    const url = new URL(mod.rauthyEndSessionUrl("hint"));
    expect(url.pathname).toBe("/auth/v1/oidc/logout");
  });
});

describe("the id-hint cookie (spec 005)", () => {
  it("is path-scoped to the auth surface and httpOnly", () => {
    const cookie = serializeCookie(OIDC_ID_HINT_COOKIE, "hint", idHintCookieOptions(60));
    expect(cookie).toContain("oidc_id_hint=hint");
    expect(cookie).toContain("Path=/api/v1/auth");
    expect(cookie).toContain("HttpOnly");
  });

  it("clears with the same path it was set under", () => {
    const cleared = serializeCookie(OIDC_ID_HINT_COOKIE, "", idHintCookieOptions(0));
    expect(cleared).toContain("Path=/api/v1/auth");
    expect(cleared).toContain("Max-Age=0");
  });
});
