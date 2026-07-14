import { describe, expect, it } from "vitest";

import { hasRole, requireRole } from "./roles";

describe("hasRole (any-of)", () => {
  it("matches when the caller holds any required role", () => {
    expect(hasRole(["user"], "user")).toBe(true);
    expect(hasRole(["user"], ["admin", "user"])).toBe(true);
    expect(hasRole(["user", "developer"], ["admin", "developer"])).toBe(true);
  });

  it("fails when the caller holds none of the required roles", () => {
    expect(hasRole(["user"], "admin")).toBe(false);
    expect(hasRole([], "user")).toBe(false);
  });

  it("treats an empty requirement as satisfied", () => {
    expect(hasRole(["user"], [])).toBe(true);
  });
});

describe("requireRole", () => {
  it("throws when the role is missing", () => {
    expect(() => requireRole({ roles: ["user"] }, "admin")).toThrow();
  });

  it("does not throw when any required role is present", () => {
    expect(() => requireRole({ roles: ["user", "admin"] }, ["admin"])).not.toThrow();
  });
});
