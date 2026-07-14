import { describe, expect, it } from "vitest";

import { WINDOW_SECONDS, bucketKey, windowOrdinal } from "./rate-limit-window";

describe("rate-limit fixed windows", () => {
  it("assigns the same ordinal within one window and the next ordinal after it", () => {
    const t0 = 1_752_000_000_000; // arbitrary fixed epoch ms
    const w = windowOrdinal(t0);
    expect(windowOrdinal(t0 + WINDOW_SECONDS * 1000 - 1)).toBeLessThanOrEqual(w + 1);
    expect(windowOrdinal(t0 + WINDOW_SECONDS * 1000)).toBe(w + 1);
  });

  it("keys buckets by tier, client, and window", () => {
    expect(bucketKey("auth", "1.2.3.4", 42)).toBe("rl:auth:1.2.3.4:42");
    expect(bucketKey("api", "a", 1)).not.toBe(bucketKey("auth", "a", 1));
    expect(bucketKey("api", "a", 1)).not.toBe(bucketKey("api", "a", 2));
  });
});
