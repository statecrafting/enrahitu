import { describe, expect, it } from "vitest";

import { constantTimeEqual, generateCsrfToken, isCsrfExempt } from "./csrf";

describe("csrf double-submit", () => {
  it("constant-time compare matches only identical tokens", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
  });

  it("generates a 256-bit hex token", () => {
    expect(generateCsrfToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exempts SSO callbacks, refresh, and safe methods only", () => {
    expect(isCsrfExempt("GET", "/api/v1/auth/rauthy/callback")).toBe(true);
    expect(isCsrfExempt("POST", "/api/v1/auth/refresh")).toBe(true);
    expect(isCsrfExempt("GET", "/api/v1/auth/me")).toBe(true);
    expect(isCsrfExempt("POST", "/api/v1/auth/logout")).toBe(false);
  });
});
