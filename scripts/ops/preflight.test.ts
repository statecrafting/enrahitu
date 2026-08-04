/**
 * The pre-flight verb (spec 027 §3.5, acceptance item 8).
 *
 * Item 8 asks for a named cause per condition, verified one at a time, which is
 * what the describe blocks below are: one per condition, each driving the check
 * in isolation rather than inferring it from a composite run. The composite is
 * covered once, at the end, for the property only it has: that a failure
 * anywhere makes the verb refuse.
 *
 * The port and ledger checks take injected probes. Not for speed: a suite that
 * binds 8081 or opens a Postgres connection passes or fails on what else is
 * running on the machine, which is the opposite of what a test of the check's
 * logic is for. The real probe is exercised separately against a port this file
 * binds itself.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkDataDir,
  checkLedgerUrl,
  checkMigrations,
  checkPorts,
  checkPublicUrl,
  checkRequiredEnv,
  format,
  loadDeclaredMigrations,
  plannedPorts,
  preflight,
  probePort,
  type CheckResult,
} from "./preflight.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const VERB = join(HERE, "preflight.mjs");

/** A never-fails probe, so a check under test is the only thing under test. */
const allFree = async () => true;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "preflight-"));
});

afterEach(() => {
  // 0500 is left behind by the ownership test; restore before removing.
  try {
    chmodSync(dir, 0o700);
  } catch {
    // already gone
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("required env (spec 007's check, promoted to a verb)", () => {
  it("names every missing variable at once", () => {
    const result = checkRequiredEnv({ ENRAHITU_REQUIRED_ENV: "A,B C", A: "set" });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("B");
    expect(result.detail).toContain("C");
    // One boot, one report: the failure this replaces was fixing them one
    // restart at a time.
    expect(result.detail).not.toContain(" A");
  });

  it("counts empty as missing, matching the -z test it replaces", () => {
    expect(checkRequiredEnv({ ENRAHITU_REQUIRED_ENV: "A", A: "" }).status).toBe("fail");
  });

  it("passes when nothing is declared", () => {
    expect(checkRequiredEnv({}).status).toBe("pass");
  });

  it("passes when every declared name is set", () => {
    expect(checkRequiredEnv({ ENRAHITU_REQUIRED_ENV: "A, B", A: "1", B: "2" }).status).toBe("pass");
  });
});

describe("public URL and the cookie mode it selects", () => {
  it("refuses a value that is not a URL", () => {
    const result = checkPublicUrl({ ENRAHITU_PUBLIC_URL: "not a url" });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("not a URL");
  });

  // The one this check exists for: a missing "//" parses as a scheme, so the
  // entrypoint's https branch is not taken and rauthy boots with
  // danger-insecure cookies on what the operator believed was a real URL.
  it("refuses a scheme that is neither http nor https", () => {
    const result = checkPublicUrl({ ENRAHITU_PUBLIC_URL: "localhost:8080" });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("danger-insecure");
  });

  it("passes https, naming the mode the entrypoint will select", () => {
    const result = checkPublicUrl({ ENRAHITU_PUBLIC_URL: "https://members.example.org" });
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("Secure");
  });

  it("passes plain http on loopback, which is the documented local trial", () => {
    expect(checkPublicUrl({ ENRAHITU_PUBLIC_URL: "http://localhost:8080" }).status).toBe("pass");
    expect(checkPublicUrl({ ENRAHITU_PUBLIC_URL: "http://127.0.0.1:4000" }).status).toBe("pass");
  });

  // Reported, not judged: an association running behind its own terminator on a
  // LAN is a real deployment, and refusing it would be this verb deciding a
  // topology it cannot see.
  it("warns rather than fails on plain http off loopback", () => {
    const result = checkPublicUrl({ ENRAHITU_PUBLIC_URL: "http://members.example.org" });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("not be marked Secure");
  });

  it("falls back to the entrypoint's own default", () => {
    expect(checkPublicUrl({}).status).toBe("pass");
    expect(checkPublicUrl({}).detail).toContain("localhost:8080");
  });
});

describe("data directory", () => {
  it("passes a writable directory", () => {
    const result = checkDataDir({ ENRAHITU_DATA_DIR: dir });
    expect(result.status).toBe("pass");
  });

  it("passes a missing directory whose parent is writable, as a fresh volume is", () => {
    const result = checkDataDir({ ENRAHITU_DATA_DIR: join(dir, "data") });
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("first-boot");
  });

  it("fails when the parent does not exist either", () => {
    const result = checkDataDir({ ENRAHITU_DATA_DIR: join(dir, "missing", "data") });
    expect(result.status).toBe("fail");
  });

  it("fails when the path is a file", () => {
    const path = join(dir, "data");
    writeFileSync(path, "");
    expect(checkDataDir({ ENRAHITU_DATA_DIR: path }).status).toBe("fail");
  });

  // The legacy root-owned-volume failure (spec 007), which used to surface as a
  // crash inside first-boot. Skipped as root, where the premise cannot hold.
  it.skipIf(process.getuid?.() === 0)("names the owner when the directory is not writable", () => {
    chmodSync(dir, 0o500);
    const result = checkDataDir({ ENRAHITU_DATA_DIR: dir });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("chown");
    expect(result.detail).toContain("mode 500");
  });
});

describe("ledger URL", () => {
  it("maps each known scheme to its driver", () => {
    const cases: Array<[string, string]> = [
      ["file:/data/ledger/enrahitu.db", "libsql"],
      ["libsql://db.turso.io", "libsql"],
      ["postgres://user@host/db", "postgres"],
      ["postgresql://user@host/db", "postgres"],
    ];
    for (const [url, driver] of cases) {
      const result = checkLedgerUrl({ ENRAHITU_LEDGER_URL: url });
      expect(result.status, url).toBe("pass");
      expect(result.detail, url).toContain(driver);
    }
  });

  // rawDriverFromEnv() routes anything non-Postgres to libSQL, so this is the
  // one place the mistake is legible instead of arriving as a client error.
  it("refuses a bare path, which the driver would accept and then fail on", () => {
    const result = checkLedgerUrl({ ENRAHITU_LEDGER_URL: "/data/ledger/enrahitu.db" });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("file:");
  });

  it("refuses a scheme no driver claims", () => {
    const result = checkLedgerUrl({ ENRAHITU_LEDGER_URL: "mysql://host/db" });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("mysql");
  });

  it("keeps a password out of the report", () => {
    const result = checkLedgerUrl({ ENRAHITU_LEDGER_URL: "postgres://user:hunter2@host/db" });
    expect(result.detail).not.toContain("hunter2");
    expect(result.detail).toContain("***");
  });
});

describe("ports", () => {
  it("derives the app's port from the environment, not from a constant", () => {
    // The packaged image sets neither and the runtime lands on 8080; the dev
    // topology (spec 033) sets PORT=4000. A hardcoded 8080 would check a port
    // the dev container was never going to bind.
    const packaged = plannedPorts({}).find((entry) => entry.label === "app");
    expect(packaged).toEqual({ label: "app", host: "0.0.0.0", port: 8080 });
    expect(plannedPorts({ PORT: "4000" }).find((entry) => entry.label === "app")?.port).toBe(4000);
    expect(
      plannedPorts({ ENCORE_LISTEN_ADDR: "127.0.0.1:9000" }).find((entry) => entry.label === "app"),
    ).toEqual({ label: "app", host: "127.0.0.1", port: 9000 });
  });

  it("plans rauthy's three and both hiqlite pairs", () => {
    const ports = plannedPorts({}).map((entry) => entry.port);
    expect(ports).toEqual([8080, 8081, 8100, 8200, 8300, 8400]);
  });

  it("follows the hiqlite addresses the entrypoint exports", () => {
    const ports = plannedPorts({
      ENRAHITU_HIQ_ADDR_RAFT: "127.0.0.1:9300",
      ENRAHITU_HIQ_ADDR_API: "127.0.0.1:9400",
    });
    expect(ports.filter((entry) => entry.label.startsWith("app hiqlite")).map((e) => e.port)).toEqual(
      [9300, 9400],
    );
  });

  it("names every occupied port, with the process that wanted it", async () => {
    const busy = new Set([8100]);
    const result = await checkPorts(
      {},
      { probe: async (_host, port) => !busy.has(port) },
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("8100");
    expect(result.detail).toContain("rauthy hiqlite raft");
  });

  it("passes when every planned port is free", async () => {
    expect((await checkPorts({}, { probe: allFree })).status).toBe("pass");
  });

  // The real probe, against a socket this test owns, so the injected one above
  // is a stand-in for something proven rather than for something assumed.
  it("reports a bound port as unavailable and a free one as available", async () => {
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        resolve((server.address() as { port: number }).port);
      });
    });
    try {
      expect(await probePort("127.0.0.1", port)).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await probePort("127.0.0.1", port)).toBe(true);
  });
});

describe("migrations, reported rather than judged", () => {
  const declared = (versions: number[]) => async () => ({
    migrations: versions.map((version) => ({ version, name: `m${version}` })),
  });

  it("reports the pending versions by name", async () => {
    const result = await checkMigrations(
      {},
      { declared: declared([1, 2, 3]), applied: async () => ({ versions: [1] }) },
    );
    expect(result.status).toBe("info");
    expect(result.detail).toContain("2 pending of 3");
    expect(result.detail).toContain("m2");
    expect(result.detail).toContain("m3");
  });

  it("reports the absence of pending work just as plainly", async () => {
    const result = await checkMigrations(
      {},
      { declared: declared([1]), applied: async () => ({ versions: [1] }) },
    );
    expect(result.detail).toContain("all applied");
  });

  // The dev container's first boot reaches pre-flight before `npm ci` has put a
  // driver on disk, and a Postgres topology's server may still be starting.
  // Neither is a reason to refuse a boot.
  it("stays non-blocking when the ledger cannot be read", async () => {
    const result = await checkMigrations(
      {},
      { declared: declared([1]), applied: async () => ({ error: "no driver installed" }) },
    );
    expect(result.status).toBe("info");
    expect(result.detail).toContain("unknown");
  });

  it("does not open a file: ledger that does not exist yet", async () => {
    const path = join(dir, "absent.db");
    const result = await checkMigrations({ ENRAHITU_LEDGER_URL: `file:${path}` });
    expect(result.status).toBe("info");
    expect(result.detail).toContain("no ledger file yet");
    expect(existsSync(path)).toBe(false);
  });
});

// The constraint stated in migration-list.ts, enforced here: pre-flight loads
// the declared home by path under plain node, so a value import at module level
// would break the report at boot rather than in CI.
describe("the declared migration home", () => {
  it("loads outside the app, with plain node and no bundler", async () => {
    const declared = await loadDeclaredMigrations(REPO_ROOT);
    expect(declared.error).toBeUndefined();
    expect(Array.isArray(declared.migrations)).toBe(true);
    for (const migration of declared.migrations ?? []) {
      expect(typeof migration.version).toBe("number");
      expect(typeof migration.name).toBe("string");
    }
  });

  it("reports a missing home rather than throwing", async () => {
    const declared = await loadDeclaredMigrations(dir);
    expect(declared.error).toContain("migration-list.ts");
  });
});

describe("the verb", () => {
  const good = {
    ENRAHITU_PUBLIC_URL: "https://members.example.org",
    ENRAHITU_LEDGER_URL: "file:/does/not/exist.db",
  };

  it("passes a sound environment", async () => {
    const { ok, checks } = await preflight(
      { ...good, ENRAHITU_DATA_DIR: dir },
      { ports: { probe: allFree } },
    );
    expect(ok).toBe(true);
    expect(checks.map((entry: CheckResult) => entry.name)).toEqual([
      "required-env",
      "public-url",
      "data-dir",
      "ledger-url",
      "ports",
      "migrations",
    ]);
  });

  it("refuses when any single condition is unmet", async () => {
    const { ok, checks } = await preflight(
      { ...good, ENRAHITU_DATA_DIR: join(dir, "missing", "data") },
      { ports: { probe: allFree } },
    );
    expect(ok).toBe(false);
    expect(checks.filter((entry: CheckResult) => entry.status === "fail")).toHaveLength(1);
  });

  // A warning is said out loud and boots anyway. The distinction is the whole
  // of the judged/reported split in §3.5.
  it("boots on a warning", async () => {
    const { ok, checks } = await preflight(
      { ENRAHITU_PUBLIC_URL: "http://members.example.org", ENRAHITU_DATA_DIR: dir },
      { ports: { probe: allFree } },
    );
    expect(ok).toBe(true);
    expect(checks.some((entry: CheckResult) => entry.status === "warn")).toBe(true);
  });

  it("formats one aligned line per check", () => {
    const lines = format([
      { name: "ports", status: "fail", detail: "8081 in use" },
      { name: "migrations", status: "info", detail: "none declared" },
    ]);
    expect(lines[0]).toContain("FAIL");
    expect(lines[1]).toContain("note");
    expect(lines[0].indexOf("8081")).toBe(lines[1].indexOf("none"));
  });
});


describe("the CLI", () => {
  function run(env: Record<string, string>): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(process.execPath, [VERB], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", ...env },
      });
      return { status: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      return { status: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  // Exit code is the verdict (spec 009 §3.2), and the entrypoint runs under
  // `set -e`, so this is what makes the boot stop.
  it("exits nonzero and names the cause", () => {
    const { status, stderr } = run({
      ENRAHITU_REQUIRED_ENV: "ENRAHITU_ADMIN_EMAIL",
      ENRAHITU_PUBLIC_URL: "https://members.example.org",
      ENRAHITU_LEDGER_URL: "file:/does/not/exist.db",
      ENRAHITU_DATA_DIR: dir,
    });
    expect(status).toBe(1);
    expect(stderr).toContain("ENRAHITU_ADMIN_EMAIL");
    expect(stderr).toContain("refusing to start");
  });

  it("reports every condition, not only the failing one", () => {
    const { stdout, stderr } = run({
      ENRAHITU_REQUIRED_ENV: "NOT_SET_ANYWHERE",
      ENRAHITU_PUBLIC_URL: "https://members.example.org",
      ENRAHITU_LEDGER_URL: "file:/does/not/exist.db",
      ENRAHITU_DATA_DIR: dir,
    });
    const all = `${stdout}${stderr}`;
    for (const name of ["required-env", "public-url", "data-dir", "ledger-url", "migrations"]) {
      expect(all, name).toContain(name);
    }
  });
});
