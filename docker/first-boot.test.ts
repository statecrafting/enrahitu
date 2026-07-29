/**
 * first-boot provisioning (spec 007) with the /metrics bearer token added by
 * spec 025 §3.4.
 *
 * The script is driven entirely by ENRAHITU_DATA_DIR, so it runs against a
 * temp volume here. The property under test is the one that matters
 * operationally: provisioning is write-once, so a restart or an upgrade never
 * rotates material an operator has already configured a scraper (or a fleet)
 * against.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIRST_BOOT = join(HERE, "first-boot.mjs");

let data: string;

function runFirstBoot(): void {
  execFileSync(process.execPath, [FIRST_BOOT], {
    env: { ...process.env, ENRAHITU_DATA_DIR: data },
    stdio: "ignore",
  });
}

/** Permission bits only, dropping the file-type bits. */
function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "enrahitu-first-boot-"));
});
afterEach(() => rmSync(data, { recursive: true, force: true }));

describe("first-boot: /metrics token provisioning", () => {
  it("generates the token 0600 so the packaged image is authenticated by default", () => {
    runFirstBoot();
    const path = join(data, "keys", "metrics-token");
    expect(readFileSync(path, "utf8")).toHaveLength(48);
    expect(mode(path)).toBe(0o600);
  });

  it("does not rotate the token on a second boot", () => {
    runFirstBoot();
    const path = join(data, "keys", "metrics-token");
    const first = readFileSync(path, "utf8");
    runFirstBoot();
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  it("leaves every other provisioned secret untouched on a second boot", () => {
    runFirstBoot();
    const paths = [
      join(data, "keys", "access-private.pem"),
      join(data, "keys", "refresh-private.pem"),
      join(data, "keys", "rauthy-client-secret"),
      join(data, "rauthy", "admin-password"),
      join(data, "rauthy", "secrets.env"),
    ];
    const before = paths.map((p) => readFileSync(p, "utf8"));
    runFirstBoot();
    expect(paths.map((p) => readFileSync(p, "utf8"))).toEqual(before);
  });

  it("keeps secret material unreadable to other users", () => {
    runFirstBoot();
    expect(mode(join(data, "keys", "metrics-token"))).toBe(0o600);
    expect(mode(join(data, "keys", "access-private.pem"))).toBe(0o600);
    expect(mode(join(data, "rauthy", "secrets.env"))).toBe(0o600);
  });
});
