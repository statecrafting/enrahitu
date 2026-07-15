import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { platformPackage, resolveBinary } from "./resolve.mjs";

/** A throwaway app root with an optional file materialized at `rel`. */
function fixtureRoot(rel?: string): string {
  const root = mkdtempSync(join(tmpdir(), "enrahitu-resolve-"));
  if (rel) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "");
  }
  return root;
}

describe("platformPackage", () => {
  it("maps the supported matrix", () => {
    expect(platformPackage("darwin", "arm64")).toBe("@enrahitu/toolchain-darwin-arm64");
    expect(platformPackage("linux", "x64")).toBe("@enrahitu/toolchain-linux-x64");
    expect(platformPackage("linux", "arm64")).toBe("@enrahitu/toolchain-linux-arm64");
  });

  it("returns null off the matrix (e.g. Windows)", () => {
    expect(platformPackage("win32", "x64")).toBeNull();
  });
});

describe("resolveBinary layering (spec 018 §3)", () => {
  it("1. an existing env override wins over everything", () => {
    const override = join(fixtureRoot("bin/encore-runtime.node"), "bin/encore-runtime.node");
    const cwd = fixtureRoot("vendor/encore/target/release/encore-runtime.node");
    expect(
      resolveBinary({ binary: "encore-runtime.node", envOverride: override, cwd }),
    ).toBe(override);
  });

  it("ignores a non-existent env override and falls through", () => {
    const cwd = fixtureRoot("vendor/encore/target/release/encore-runtime.node");
    const resolved = resolveBinary({
      binary: "encore-runtime.node",
      envOverride: "/no/such/override.node",
      cwd,
      platform: "darwin",
      arch: "arm64",
    });
    expect(resolved).toBe(join(cwd, "vendor/encore/target/release/encore-runtime.node"));
  });

  it("2. prefers the node_modules platform package over the vendor build", () => {
    const cwd = fixtureRoot(
      "node_modules/@enrahitu/toolchain-linux-x64/tsparser-encore",
    );
    // also stage a vendor copy to prove the platform package is chosen first
    mkdirSync(join(cwd, "vendor/encore/target/release"), { recursive: true });
    writeFileSync(join(cwd, "vendor/encore/target/release/tsparser-encore"), "");
    const resolved = resolveBinary({
      binary: "tsparser-encore",
      cwd,
      platform: "linux",
      arch: "x64",
    });
    expect(resolved).toBe(
      join(cwd, "node_modules/@enrahitu/toolchain-linux-x64/tsparser-encore"),
    );
  });

  it("3. falls back to the in-repo vendor build for toolchain developers", () => {
    const cwd = fixtureRoot("vendor/encore/target/release/encore-runtime.node");
    const resolved = resolveBinary({
      binary: "encore-runtime.node",
      cwd,
      platform: "darwin",
      arch: "arm64",
    });
    expect(resolved).toBe(join(cwd, "vendor/encore/target/release/encore-runtime.node"));
  });

  it("returns null when no layer provides the binary", () => {
    const cwd = fixtureRoot();
    expect(
      resolveBinary({ binary: "encore-runtime.node", cwd, platform: "darwin", arch: "arm64" }),
    ).toBeNull();
  });
});
