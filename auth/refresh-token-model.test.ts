/**
 * Refresh-token model tests. The hash tests are pure crypto; the DB-bound
 * operations run against a throwaway temp-file ledger (vitest.setup.ts), a
 * test the template could only run against live Postgres.
 */
import { describe, expect, it } from "vitest";

import { hashRefreshToken } from "../lib/jwt";

import {
  findActiveRefreshToken,
  revokeAllUserTokens,
  revokeRefreshToken,
  storeRefreshToken,
} from "./refresh-token-model";

describe("hashRefreshToken", () => {
  it("produces a 64-character lowercase hex string (SHA-256 output width)", () => {
    expect(hashRefreshToken("some-opaque-token-value")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic and collision-distinct for distinct tokens", () => {
    expect(hashRefreshToken("t1")).toBe(hashRefreshToken("t1"));
    expect(hashRefreshToken("t1")).not.toBe(hashRefreshToken("t2"));
  });

  it("matches the NIST SHA-256 vector for the empty string", () => {
    expect(hashRefreshToken("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("refresh-token store (temp-file ledger)", () => {
  const future = () => new Date(Date.now() + 60_000);

  it("stores hash-only and finds the active token", async () => {
    const id = await storeRefreshToken({
      userID: "user-1",
      token: "raw-token-a",
      expiresAt: future(),
      userAgent: "vitest",
      ipAddress: "127.0.0.1",
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const active = await findActiveRefreshToken("raw-token-a");
    expect(active?.id).toBe(id);
    expect(active?.userId).toBe("user-1");
    // The raw token never appears in the stored record.
    expect(active?.tokenHash).toBe(hashRefreshToken("raw-token-a"));
    expect(active?.tokenHash).not.toContain("raw-token-a");
  });

  it("returns null for expired tokens", async () => {
    await storeRefreshToken({
      userID: "user-1",
      token: "raw-token-expired",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await findActiveRefreshToken("raw-token-expired")).toBeNull();
  });

  it("rotation: revoking with a replacement makes the old token inert", async () => {
    const oldId = await storeRefreshToken({
      userID: "user-2",
      token: "raw-token-old",
      expiresAt: future(),
    });
    const newId = await storeRefreshToken({
      userID: "user-2",
      token: "raw-token-new",
      expiresAt: future(),
    });

    await revokeRefreshToken(oldId, newId);
    expect(await findActiveRefreshToken("raw-token-old")).toBeNull();
    expect((await findActiveRefreshToken("raw-token-new"))?.id).toBe(newId);
    // Revoking twice is a no-op.
    await revokeRefreshToken(oldId);
  });

  it("revokeAllUserTokens is logout-everywhere for one user only", async () => {
    await storeRefreshToken({ userID: "user-3", token: "u3-a", expiresAt: future() });
    await storeRefreshToken({ userID: "user-3", token: "u3-b", expiresAt: future() });
    await storeRefreshToken({ userID: "user-4", token: "u4-a", expiresAt: future() });

    await revokeAllUserTokens("user-3");
    expect(await findActiveRefreshToken("u3-a")).toBeNull();
    expect(await findActiveRefreshToken("u3-b")).toBeNull();
    expect(await findActiveRefreshToken("u4-a")).not.toBeNull();
  });
});
