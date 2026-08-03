/**
 * The principal and the session envelope (spec 004, rewritten 2026-08-03).
 *
 * Each property is stated as the failure it prevents. The three that matter
 * were all live defects before this rewrite, and none of them was visible from
 * the outside: the session's subject was the wrong identifier, the address it
 * carried was unverified, and a display handle could stand in for that address.
 */
import { describe, expect, it, vi } from "vitest";

import { profileFromClaims } from "./rauthy";

describe("the principal comes from the IdP (spec 004 §3.2)", () => {
  const base = {
    sub: "rauthy-abc-123",
    email: "ada@example.org",
    email_verified: true,
    name: "Ada Lovelace",
    roles: ["user", "enrahitu_operator"],
  };

  it("takes the IdP's sub as the subject, which is what the domain binds to", () => {
    // Before the rewrite this became `ssoProviderId` on a local row while the
    // session's subject was a fresh UUID, so spec 036 §3.8's `member.sub`
    // binding could never match a session and the fallback did all the work.
    expect(profileFromClaims(base).subject).toBe("rauthy-abc-123");
  });

  it("carries email_verified through, because it is an authorization input", () => {
    expect(profileFromClaims(base).emailVerified).toBe(true);
    expect(profileFromClaims({ ...base, email_verified: false }).emailVerified).toBe(false);
    // Absent means unverified. An IdP that does not say is an IdP that did not.
    const { email_verified: _omitted, ...withoutClaim } = base;
    expect(profileFromClaims(withoutClaim).emailVerified).toBe(false);
  });

  it("refuses to treat a display handle as an address", () => {
    // `preferred_username` used to stand in for a missing email, and the member
    // plane matches on address: a provider that lets a user choose their handle
    // would have let them choose whose dues they could read.
    const profile = profileFromClaims({
      sub: "rauthy-abc-123",
      preferred_username: "grace@example.org",
      roles: ["user"],
    });
    expect(profile.email).toBe("");
    expect(profile.emailVerified).toBe(false);
    // It is still good enough to show as a name, which is all it ever was.
    expect(profile.name).toBe("grace@example.org");
  });

  it("never reports a verified address when there is no address", () => {
    const profile = profileFromClaims({ sub: "s", email_verified: true, roles: ["user"] });
    expect(profile.email).toBe("");
    expect(profile.emailVerified).toBe(false);
  });

  it("prefers roles, then groups, then the configured default", () => {
    expect(profileFromClaims(base).roles).toEqual(["user", "enrahitu_operator"]);
    const { roles: _dropped, ...noRoles } = base;
    expect(profileFromClaims({ ...noRoles, groups: ["staff"] }).roles).toEqual(["staff"]);
    expect(profileFromClaims(noRoles).roles).toEqual(["user"]);
  });
});

/**
 * The envelope round-trip, on a keypair this test generates.
 *
 * Deliberately NOT the repo's `keys/` directory: those exist on a developer's
 * machine and not on CI, so a test that signed with them would pass here and
 * fail there. `ENRAHITU_KEYS_DIR` is read once at module load, which is why the
 * import is dynamic and comes after the fixture is written.
 */
describe("the session envelope (spec 004 §3.4)", () => {
  async function jwtWithTempKeys(): Promise<{
    jwt: typeof import("../lib/jwt");
    asAuth: <T>(fn: () => T) => T;
  }> {
    const { generateKeyPairSync } = await import("node:crypto");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "session-keys-"));
    for (const name of ["access", "refresh"]) {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      writeFileSync(join(dir, `${name}-private.pem`), privateKey);
      writeFileSync(join(dir, `${name}-public.pem`), publicKey);
    }
    process.env.ENRAHITU_KEYS_DIR = dir;
    vi.resetModules();
    // The secret accessors adjudicate `secret.read` (spec 021 §3.5), so signing
    // needs a service scope, and it has to come from this same fresh registry:
    // `runAsService` writes to module-held AsyncLocalStorage, so a scope opened
    // with a different copy is invisible here.
    const jwt = await import("../lib/jwt");
    const kernel = await import("../kernel/adjudicate");
    return { jwt, asAuth: (fn) => kernel.runAsService("auth", fn) };
  }

  it("round-trips a rauthy envelope carrying the IdP's own refresh token", async () => {
    const { jwt: jwtMod, asAuth } = await jwtWithTempKeys();
    const signed = await asAuth(() =>
      jwtMod.signSession({ driver: "rauthy", refreshToken: "idp-rt-xyz", subject: "rauthy-abc-123" }),
    );
    expect(await asAuth(() => jwtMod.verifySession(signed.token))).toEqual({
      driver: "rauthy",
      refreshToken: "idp-rt-xyz",
      subject: "rauthy-abc-123",
    });
  });

  it("refuses an envelope shape this app does not issue", async () => {
    const { jwt: jwtMod, asAuth } = await jwtWithTempKeys();
    // The signature proves the app minted it; the shape check is what stops a
    // stale or hand-built payload naming a driver that no longer exists.
    for (const bad of [
      { driver: "rauthy" },
      // A rauthy envelope with no pinned subject: renewal reads claims from
      // userinfo, which is asked ABOUT a subject, so one without it is unusable.
      { driver: "rauthy", refreshToken: "x" },
      { driver: "mock" },
      { driver: "nobody", refreshToken: "x", subject: "s" },
      {},
    ]) {
      const forged = await asAuth(() => jwtMod.signSession(bad as never));
      await expect(asAuth(() => jwtMod.verifySession(forged.token))).rejects.toThrow(
        /not a shape this app issues/,
      );
    }
  });

  it("puts the IdP's subject in the access token, not a locally minted id", async () => {
    const { jwt: jwtMod, asAuth } = await jwtWithTempKeys();
    const token = await asAuth(() =>
      jwtMod.signAccessToken({
      userID: "rauthy-abc-123",
      email: "ada@example.org",
      emailVerified: true,
      name: "Ada",
      roles: ["user"],
      ssoProvider: "rauthy",
      }),
    );
    const claims = await asAuth(() => jwtMod.verifyAccessToken(token));
    expect(claims.userID).toBe("rauthy-abc-123");
    expect(claims.emailVerified).toBe(true);
  });

  it("reads a token minted without the claim as unverified", async () => {
    const { jwt: jwtMod, asAuth } = await jwtWithTempKeys();
    const token = await asAuth(() =>
      jwtMod.signAccessToken({
      userID: "s",
      email: "a@b.co",
      emailVerified: false,
      name: "A",
      roles: [],
      ssoProvider: "rauthy",
      }),
    );
    expect((await asAuth(() => jwtMod.verifyAccessToken(token))).emailVerified).toBe(false);
  });
});
