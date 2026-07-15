import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

// Drive the validator through its documented CLI (`node scripts/verify-born-with.mjs
// [path]`, spec 012 §2) rather than importing it: the .mjs ships as a
// dependency-free artifact a stamped app runs with plain node, and exercising
// the real entry point is the honest acceptance test.
const here = dirname(fileURLToPath(import.meta.url));
const validator = join(here, "verify-born-with.mjs");
const fixturePath = join(here, "fixtures", "born-with.example.json");
const fixture = () => JSON.parse(readFileSync(fixturePath, "utf8"));

// Golden hash (spec 012 §4/§6): the platform ledger anchors these same bytes,
// so a change here is a deliberate break, not a refresh.
const GOLDEN_SHA256 = "ad33056eec7e00f954da905b19062a7f0d8d559dc1e574fffda0929e570feb5b";

// Independent recursive key-sort + sha256, computed in the test with no shared
// code with the validator, to cross-check the printed hash.
function keysortHash(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === "object"
        ? Object.keys(v as Record<string, unknown>)
            .sort()
            .reduce<Record<string, unknown>>((acc, k) => {
              acc[k] = sort((v as Record<string, unknown>)[k]);
              return acc;
            }, {})
        : v;
  return createHash("sha256").update(JSON.stringify(sort(value)), "utf8").digest("hex");
}

function run(certPath: string) {
  const result = spawnSync(process.execPath, [validator, certPath], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const tmp = mkdtempSync(join(tmpdir(), "born-with-"));
function certFile(name: string, cert: unknown): string {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(cert));
  return path;
}

describe("verify-born-with: valid certificate", () => {
  it("accepts a well-formed cert, exits 0, and prints its sha256", () => {
    const { status, stdout } = run(fixturePath);
    expect(status).toBe(0);
    expect(stdout).toContain(`sha256 ${GOLDEN_SHA256}`);
  });

  it("prints a hash matching an independently computed keysorted-JSON hash", () => {
    const { stdout } = run(fixturePath);
    const printed = stdout.match(/sha256 ([0-9a-f]{64})/)?.[1];
    expect(printed).toBe(keysortHash(fixture()));
    expect(printed).toBe(GOLDEN_SHA256);
  });
});

describe("verify-born-with: schema rejections", () => {
  it("rejects a missing posture", () => {
    const cert = fixture();
    delete cert.agenticPostureBinding.posture;
    const { status, stderr } = run(certFile("missing-posture.json", cert));
    expect(status).toBe(1);
    expect(stderr).toContain('missing required property "posture"');
  });

  it("rejects defaulted: true", () => {
    const cert = fixture();
    cert.agenticPostureBinding.defaulted = true;
    const { status, stderr } = run(certFile("defaulted-true.json", cert));
    expect(status).toBe(1);
    expect(stderr).toContain("agenticPostureBinding.defaulted: must equal false");
  });

  it("rejects an unknown posture", () => {
    const cert = fixture();
    cert.agenticPostureBinding.posture = "supervised";
    const { status, stderr } = run(certFile("unknown-posture.json", cert));
    expect(status).toBe(1);
    expect(stderr).toContain("agenticPostureBinding.posture: must be one of");
  });

  it("rejects a short commit", () => {
    const cert = fixture();
    cert.template.commit = "abc123";
    const { status, stderr } = run(certFile("short-commit.json", cert));
    expect(status).toBe(1);
    expect(stderr).toContain("template.commit: must match");
  });

  it("rejects an unexpected top-level property", () => {
    const cert = fixture();
    cert.surprise = true;
    const { status, stderr } = run(certFile("extra-prop.json", cert));
    expect(status).toBe(1);
    expect(stderr).toContain('unexpected property "surprise"');
  });

  it("rejects the wrong certVersion", () => {
    const cert = fixture();
    cert.certVersion = "2";
    const { status, stderr } = run(certFile("wrong-version.json", cert));
    expect(status).toBe(1);
    expect(stderr).toContain('certVersion: must equal "1"');
  });
});
