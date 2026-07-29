import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

// The AGPL boundary guard (spec 001 §4.7). Driven through its documented CLI
// rather than imported, matching scripts/verify-born-with.test.ts: the .mjs is
// a dependency-free artifact run with plain node, and the real entry point is
// the honest acceptance test.
//
// The failure paths matter more than the clean path here. A license guard that
// has never been observed to fail is indistinguishable from one that cannot.
const here = dirname(fileURLToPath(import.meta.url));
const guard = join(here, "check-licenses.mjs");

interface Summary {
  ok: boolean;
  lockPackagesChecked: number;
  installedPackagesChecked: number;
  installedTreeScanned: boolean;
  violations: { source: string; name: string; license: string; detail: string }[];
}

function run(repo: string): { status: number; summary: Summary } {
  const res = spawnSync(process.execPath, [guard, "--repo", repo, "--json"], {
    encoding: "utf8",
  });
  return { status: res.status ?? -1, summary: JSON.parse(res.stdout) as Summary };
}

/** A minimal repo tree: manifest + lockfile, no installed node_modules. */
function fixture(opts: {
  dependencies?: Record<string, string>;
  lockPackages?: Record<string, { version: string; license?: string; name?: string }>;
  installed?: { path: string; name: string; license?: string }[];
}): string {
  const dir = mkdtempSync(join(tmpdir(), "check-licenses-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: opts.dependencies ?? {} }),
  );
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { name: "fixture" }, ...(opts.lockPackages ?? {}) },
    }),
  );
  for (const pkg of opts.installed ?? []) {
    const full = join(dir, pkg.path);
    mkdirSync(full, { recursive: true });
    writeFileSync(
      join(full, "package.json"),
      JSON.stringify({ name: pkg.name, version: "1.0.0", license: pkg.license }),
    );
  }
  return dir;
}

describe("check-licenses (spec 001 §4.7)", () => {
  it("passes a clean tree", () => {
    const { status, summary } = run(
      fixture({
        dependencies: { "@statecrafting/kernel-native": "^0.1.0" },
        lockPackages: {
          "node_modules/@statecrafting/kernel-native": {
            version: "0.1.0",
            license: "Apache-2.0",
          },
        },
      }),
    );
    expect(status).toBe(0);
    expect(summary.ok).toBe(true);
    expect(summary.violations).toEqual([]);
  });

  it("fails on the forbidden package declared as a direct dependency", () => {
    const { status, summary } = run(
      fixture({ dependencies: { "@statecrafting/governance-native": "^0.1.0" } }),
    );
    expect(status).toBe(1);
    expect(summary.ok).toBe(false);
    expect(summary.violations.map((v) => v.source)).toContain("package.json");
    expect(summary.violations[0].name).toBe("@statecrafting/governance-native");
  });

  // The whole reason the guard exists: the two names differ by one word, and a
  // mislabelled or absent license field must not buy a pass.
  it("fails on the forbidden package even when it claims a permissive license", () => {
    const { status, summary } = run(
      fixture({
        lockPackages: {
          "node_modules/@statecrafting/governance-native": {
            version: "0.1.0",
            license: "Apache-2.0",
          },
        },
      }),
    );
    expect(status).toBe(1);
    expect(summary.violations[0].name).toBe("@statecrafting/governance-native");
  });

  it("fails on any transitively pulled AGPL package", () => {
    const { status, summary } = run(
      fixture({
        lockPackages: {
          "node_modules/some-dep/node_modules/copyleft-lib": {
            version: "2.0.0",
            license: "AGPL-3.0-only",
          },
        },
      }),
    );
    expect(status).toBe(1);
    expect(summary.violations[0].name).toBe("copyleft-lib");
    expect(summary.violations[0].license).toBe("AGPL-3.0-only");
  });

  it("catches an installed package the lockfile does not admit to", () => {
    const { status, summary } = run(
      fixture({
        installed: [
          { path: "node_modules/sneaky", name: "sneaky", license: "AGPL-3.0" },
        ],
      }),
    );
    expect(status).toBe(1);
    expect(summary.installedTreeScanned).toBe(true);
    expect(summary.violations.map((v) => v.source)).toContain("node_modules");
  });

  it("scans scoped and nested installed packages", () => {
    const { status, summary } = run(
      fixture({
        installed: [
          {
            path: "node_modules/@statecrafting/governance-native",
            name: "@statecrafting/governance-native",
            license: "AGPL-3.0",
          },
        ],
      }),
    );
    expect(status).toBe(1);
    expect(summary.violations[0].name).toBe("@statecrafting/governance-native");
  });

  // MPL-2.0 is file-level copyleft and the Encore core is consumed under it by
  // design (spec 008), so it must not trip the guard.
  it("does not flag MPL-2.0", () => {
    const { status, summary } = run(
      fixture({
        lockPackages: {
          "node_modules/encore-ish": { version: "1.0.0", license: "MPL-2.0" },
        },
      }),
    );
    expect(status).toBe(0);
    expect(summary.ok).toBe(true);
  });

  it("reports the installed tree as unscanned when node_modules is absent", () => {
    const { summary } = run(fixture({}));
    expect(summary.installedTreeScanned).toBe(false);
    expect(summary.installedPackagesChecked).toBe(0);
  });
});
