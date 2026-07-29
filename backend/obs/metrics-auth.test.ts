import { describe, expect, it } from "vitest";

import { bearerToken, metricsAuthorized, tokenMatches } from "./metrics-auth";

const TOKEN = "s3cret-metrics-token";

describe("/metrics bearer authentication (spec 025 §3.4)", () => {
  it("serves unauthenticated when no token is configured (dev and the suite)", () => {
    expect(metricsAuthorized(undefined, undefined)).toBe(true);
    expect(metricsAuthorized(undefined, "")).toBe(true);
    expect(metricsAuthorized("Bearer anything", undefined)).toBe(true);
  });

  it("accepts the correct bearer once a token is configured", () => {
    expect(metricsAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("refuses a missing, empty, wrong, or truncated token", () => {
    expect(metricsAuthorized(undefined, TOKEN)).toBe(false);
    expect(metricsAuthorized("", TOKEN)).toBe(false);
    expect(metricsAuthorized("Bearer ", TOKEN)).toBe(false);
    expect(metricsAuthorized("Bearer wrong", TOKEN)).toBe(false);
    expect(metricsAuthorized(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe(false);
  });

  it("refuses a non-bearer scheme carrying the right value", () => {
    expect(metricsAuthorized(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(metricsAuthorized(TOKEN, TOKEN)).toBe(false);
  });

  it("treats the scheme name case-insensitively, per RFC 9110", () => {
    expect(metricsAuthorized(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(metricsAuthorized(`BEARER ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("reads the first value when the header is repeated", () => {
    expect(metricsAuthorized([`Bearer ${TOKEN}`, "Bearer other"], TOKEN)).toBe(true);
    expect(metricsAuthorized(["Bearer wrong", `Bearer ${TOKEN}`], TOKEN)).toBe(false);
  });
});

describe("bearerToken", () => {
  it("extracts the value and tolerates surrounding whitespace", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("  Bearer   abc  ")).toBe("abc");
  });

  it("returns undefined for absent or malformed headers", () => {
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken("")).toBeUndefined();
    expect(bearerToken("Bearer")).toBeUndefined();
    expect(bearerToken("Basic abc")).toBeUndefined();
  });
});

describe("tokenMatches", () => {
  it("compares by value", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
  });

  it("rejects on length before comparing content", () => {
    expect(tokenMatches("abc", "abcd")).toBe(false);
    expect(tokenMatches("", "abc")).toBe(false);
    expect(tokenMatches("", "")).toBe(true);
  });
});
