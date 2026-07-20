import { describe, expect, it } from "vitest";

import { runAsService } from "../kernel/adjudicate";

import { getUserById, upsertUserFromProfile } from "./user-model";

// Tests run outside request context, so kernel attribution is pinned to
// the service under test (spec 021 §3.5: unattributable is denied).
const asAuth = (fn: () => Promise<void>) => () => runAsService("auth", fn);

describe("upsertUserFromProfile (temp-file ledger)", () => {
  it("creates a user on first login and normalizes the email", asAuth(async () => {
    const user = await upsertUserFromProfile({
      ssoProvider: "mock",
      ssoProviderId: "mock-user",
      email: "Casey.User@Example.com",
      name: "Casey User",
      roles: ["user"],
      attributes: { department: "General" },
    });
    expect(user.email).toBe("casey.user@example.com");
    expect(user.roles).toEqual(["user"]);
    expect(user.lastLoginAt).toBeInstanceOf(Date);
    expect(await getUserById(user.id)).not.toBeNull();
  }));

  it("updates the same row on repeat login regardless of email case", asAuth(async () => {
    const first = await upsertUserFromProfile({
      ssoProvider: "mock",
      ssoProviderId: "mock-admin",
      email: "admin@example.com",
      name: "Avery Admin",
      roles: ["user", "admin"],
    });
    const second = await upsertUserFromProfile({
      ssoProvider: "rauthy",
      ssoProviderId: "rauthy-123",
      email: "ADMIN@example.com",
      name: "Avery A. Admin",
      roles: ["user", "admin", "developer"],
    });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Avery A. Admin");
    expect(second.roles).toEqual(["user", "admin", "developer"]);
    expect(second.ssoProvider).toBe("rauthy");
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  }));
});
