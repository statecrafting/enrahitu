import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TOPOLOGIES, render } from "./gen-infra-config.mjs";

// The generator (spec 033 §3.4). Driven through both its API and its CLI: the
// API is what the tests assert against, the CLI is what CI runs, and a drift
// gate nobody has watched fail is a drift gate nobody knows is broken.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const generator = join(here, "gen-infra-config.mjs");

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [generator, ...args], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("gen-infra-config", () => {
  // The property that makes adopting the generator safe: it reproduces what was
  // previously hand-written, so the change is a refactor and not a reformat.
  it("regenerates every committed config byte for byte", () => {
    for (const [name, spec] of Object.entries(TOPOLOGIES)) {
      const committed = readFileSync(join(repoRoot, spec.file), "utf8");
      expect(render(name), `${spec.file} drifted`).toBe(committed);
    }
  });

  it("passes --check against the committed tree", () => {
    const { status, stdout } = runCli(["--check"]);
    expect(status).toBe(0);
    expect(stdout).toContain("fresh");
  });

  describe("the topologies differ only where they must", () => {
    it("declares secrets for selfhost and not for dev", () => {
      const selfhost = JSON.parse(render("selfhost")) as Record<string, unknown>;
      const dev = JSON.parse(render("dev")) as Record<string, unknown>;
      expect(selfhost.secrets).toBeDefined();
      // Deliberate: with no secrets declared, secret() yields "" and
      // backend/lib/secrets.ts falls back to the PEM files in the keys dir,
      // which is what lets a developer run without provisioning anything.
      expect(dev.secrets).toBeUndefined();
    });

    it("declares secrets only as $env references, never values", () => {
      const { secrets } = JSON.parse(render("selfhost")) as {
        secrets: Record<string, { $env?: string }>;
      };
      for (const [name, ref] of Object.entries(secrets)) {
        expect(Object.keys(ref)).toEqual(["$env"]);
        expect(ref.$env).toBe(name);
      }
    });

    it("shares the app id across topologies", () => {
      const ids = Object.keys(TOPOLOGIES).map(
        (n) => (JSON.parse(render(n)) as { metadata: { app_id: string } }).metadata.app_id,
      );
      expect(new Set(ids).size).toBe(1);
    });
  });

  // The rule stands unweakened (spec 001 §4.2 decision 2, spec 030 §3.6):
  // adopting SQLDatabase would put Encore in charge of durable state and its
  // migrations. Asserting the absence means the block cannot appear by
  // accident, only by a deliberate edit that fails this test first.
  it("populates no sql_servers block in any topology", () => {
    for (const name of Object.keys(TOPOLOGIES)) {
      const doc = JSON.parse(render(name)) as Record<string, unknown>;
      expect(doc.sql_servers, `${name} declared sql_servers`).toBeUndefined();
    }
  });

  it("rejects an unknown topology", () => {
    expect(() => render("nope")).toThrow(/unknown topology/);
  });
});
