/**
 * Pure-function tests of the extraction stage (spec 021 §3.2): canonical
 * bytes and integrity hashing, the ceiling-coverage rule, and the meta
 * lowering helpers. The end-to-end pipeline (tsparser -> lower -> verify
 * -> seal -> oracle) is exercised by CI's `enrahitu-extract --check` gate
 * over the committed model.
 */
import { describe, expect, it } from "vitest";

import {
  canonicalStringify,
  canonicalBytes,
  computeIntegrityHash,
  prettyStringify,
} from "./canonical.mjs";
import { accessString, pathString } from "./meta.mjs";
import { covered } from "./usage.mjs";

describe("canonical serialization (spec 020 §3.5)", () => {
  it("sorts keys recursively with compact separators and a trailing newline", () => {
    const bytes = canonicalBytes({ b: 1, a: { z: 1, y: [2, 1] } });
    expect(bytes.toString("utf8")).toBe('{"a":{"y":[2,1],"z":1},"b":1}\n');
  });

  it("rejects non-integer numbers: the only cross-language-stable numbers", () => {
    expect(() => canonicalStringify({ ok: 1, bad: 0.5 })).toThrow(/non-integer/);
  });

  it("computes the integrity hash over the document with integrity removed", () => {
    const doc = { a: 1, integrity: { algorithm: "x", hash: "y" } };
    expect(computeIntegrityHash(doc)).toBe(computeIntegrityHash({ a: 1 }));
    expect(computeIntegrityHash(doc)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("pretty form parses back to the same canonical bytes", () => {
    const doc = { b: [3, 1], a: "x" };
    const reparsed = JSON.parse(prettyStringify(doc));
    expect(canonicalStringify(reparsed)).toBe(canonicalStringify(doc));
  });
});

describe("ceiling coverage (spec 021 §3.2 verify)", () => {
  const grants = [
    { kind: "db.read", resource: "app" },
    { kind: "kv.get", resource: "cache" },
    { kind: "secret.read", resource: "*" },
  ];

  it("matches exact kind with exact or wildcard resource", () => {
    expect(covered({ kind: "kv.get", resource: "cache" }, grants)).toBe(true);
    expect(covered({ kind: "kv.get", resource: "other" }, grants)).toBe(false);
    expect(covered({ kind: "secret.read", resource: "anything" }, grants)).toBe(true);
    expect(covered({ kind: "kv.put", resource: "cache" }, grants)).toBe(false);
  });

  it("matches db and egress touches at family level (v0.1 granularity)", () => {
    expect(covered({ family: "db" }, grants)).toBe(true);
    expect(covered({ family: "db" }, [{ kind: "kv.get", resource: "cache" }])).toBe(false);
    expect(covered({ family: "http.egress" }, grants)).toBe(false);
    expect(covered({ family: "http.egress" }, [{ kind: "http.egress", resource: "*" }])).toBe(
      true,
    );
  });
});

describe("meta lowering helpers", () => {
  it("reconstructs encore path strings from segments", () => {
    expect(
      pathString({
        segments: [
          { type: "LITERAL", value: "auth" },
          { type: "WILDCARD", value: "rest" },
        ],
      }),
    ).toBe("/auth/*rest");
    expect(
      pathString({
        segments: [
          { type: "LITERAL", value: "hiq" },
          { type: "LITERAL", value: "kv" },
          { type: "PARAM", value: "key" },
        ],
      }),
    ).toBe("/hiq/kv/:key");
    expect(pathString({ segments: [{ type: "FALLBACK", value: "path" }] })).toBe("/!path");
  });

  it("maps access enums to the model vocabulary, private by default", () => {
    expect(accessString({ accessType: "PUBLIC" })).toBe("public");
    expect(accessString({ accessType: "AUTH" })).toBe("auth");
    expect(accessString({ accessType: "PRIVATE" })).toBe("private");
    expect(accessString({ accessType: "SOMETHING_NEW" })).toBe("private");
  });
});
