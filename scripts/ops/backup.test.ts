/**
 * `backup` and `restore` as a round trip (spec 027 §3.2-§3.3, §4 items 4 and 6).
 *
 * These run against a real volume laid out the way `first-boot.mjs` lays one
 * out, with a real libSQL ledger carrying a real genesis Decision, and produce a
 * real tar. What they do not do is stop a container, which is why §4 items 2, 3
 * and 5 remain a compose-level fixture: a cold backup is DEFINED by the
 * container being stopped, and no unit test can supply that definition.
 *
 * The liveness probe is injected rather than mocked away. Both verbs refuse on
 * the wrong side of it, and that refusal is the property most worth holding,
 * because getting it wrong is silent: a cold copy of a live raft log restores
 * cleanly and fails later.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { backup } from "./backup.mjs";
import { restore, verifyMembers } from "./restore.mjs";
import { listArchive } from "./archive.mjs";

let data: string;
let out: string;
let ledgerUrl: string;

/**
 * A stub app: the CSRF exchange, then the admin plane's backup endpoint.
 *
 * The token step is not incidental. Signing in does not issue the csrf cookie,
 * so a verb that only presented a session would be refused on every unsafe
 * method; asking for a token is what the SPA does and what these verbs do.
 */
function plane(snapshot: string) {
  return async (url: string) => {
    if (url.includes("/api/v1/auth/csrf-token")) {
      return { ok: true, json: async () => ({ token: "tok" }), headers: new Headers() } as Response;
    }
    if (url.includes("/api/admin/state/backups")) {
      return { ok: true, json: async () => ({ name: snapshot, fresh: true }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  };
}

const STOPPED = { running: false, host: "127.0.0.1", port: 8080 };
const LIVE = { running: true, host: "127.0.0.1", port: 8080 };

/** A volume shaped like the one first-boot provisions. */
function layout(dir: string) {
  for (const sub of ["ledger", "hiqlite/state_machine", "rauthy/db/state_machine/backups", "keys"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  writeFileSync(join(dir, "keys", "access-private.pem"), "PRIVATE", { mode: 0o600 });
  writeFileSync(join(dir, "rauthy", "secrets.env"), "RAUTHY_ENC_KEYS='k/v'\n", { mode: 0o600 });
  writeFileSync(join(dir, "rauthy", "admin-password"), "hunter2", { mode: 0o600 });
  // The raft directory a stopped node leaves behind, lock and owner record
  // included: both are always present, because the addon never releases them.
  writeFileSync(join(dir, "hiqlite", "state_machine", "lock"), "");
  writeFileSync(join(dir, "hiqlite", "enrahitu-owner.json"), JSON.stringify({ pid: 1 }));
  writeFileSync(join(dir, "hiqlite", "state_machine", "db"), "RAFT-STATE");
}

/** A ledger with a genesis Decision, so the manifest has hashes to record. */
async function seedLedger(url: string) {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url });
  await client.execute(
    `CREATE TABLE kernel_decisions (seq INTEGER PRIMARY KEY, record_id TEXT, payload TEXT)`,
  );
  await client.execute(
    `INSERT INTO kernel_decisions (seq, record_id, payload) VALUES (1, 'genesis-1', '{"modelHash":"sha256:aaa","gateConfigHash":"sha256:bbb"}')`,
  );
  client.close();
}

beforeEach(async () => {
  data = mkdtempSync(join(tmpdir(), "enrahitu-vol-"));
  out = mkdtempSync(join(tmpdir(), "enrahitu-out-"));
  chmodSync(out, 0o700);
  layout(data);
  ledgerUrl = `file:${join(data, "ledger", "enrahitu.db")}`;
  await seedLedger(ledgerUrl);
});

afterEach(() => {
  rmSync(data, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

const env = () => ({ ENRAHITU_DATA_DIR: data, ENRAHITU_LEDGER_URL: ledgerUrl }) as NodeJS.ProcessEnv;

describe("backup: the cold path", () => {
  it("carries every class of state on the volume", async () => {
    const { destination, manifest } = await backup(env(), { out, cell: STOPPED });
    const entries = listArchive(destination);
    expect(entries.some((e) => e.startsWith("ledger/enrahitu.db"))).toBe(true);
    expect(entries.some((e) => e.startsWith("state/"))).toBe(true);
    expect(entries.some((e) => e.startsWith("rauthy/"))).toBe(true);
    // Key material is one class across two directories (§3.1), so it is
    // gathered under one member rather than falling out of a directory copy.
    expect(entries).toContain("keys/app/access-private.pem");
    expect(entries).toContain("keys/rauthy/secrets.env");
    expect(manifest.mode).toBe("cold");
    expect(manifest.members.map((m: { name: string }) => m.name).sort()).toEqual([
      "keys",
      "ledger",
      "rauthy",
      "state",
    ]);
  });

  it("records the model and gate hashes from the chain it contains", async () => {
    // Read out of kernel_decisions rather than off the image's app-model.json,
    // so the manifest describes the data in the archive rather than whatever
    // image happened to run the verb. Restore's upgrade warning depends on the
    // difference.
    const { manifest } = await backup(env(), { out, cell: STOPPED });
    expect(manifest.modelHash).toBe("sha256:aaa");
    expect(manifest.gateConfigHash).toBe("sha256:bbb");
  });

  it("refuses a live cell, because a cold backup is defined by a stopped one", async () => {
    await expect(backup(env(), { out, cell: LIVE })).rejects.toThrow(/cold backup is defined by/);
  });

  it("refuses a destination other users can read", async () => {
    // The archive holds every secret the cell has, so the mode of the directory
    // is part of who can reach it, not merely the mode of the file.
    chmodSync(out, 0o755);
    await expect(backup(env(), { out, cell: STOPPED })).rejects.toThrow(/other users can reach/);
  });

  it("writes the archive 0600", async () => {
    const { destination } = await backup(env(), { out, cell: STOPPED });
    // Asked of node rather than of `stat`, whose mode format flag differs
    // between BSD and GNU: the first version of this used the macOS spelling
    // and passed locally while failing on CI.
    expect(statSync(destination).mode & 0o777).toBe(0o600);
  });

  it("names a remote ledger and backs up only what it owns", async () => {
    const remote = { ...env(), ENRAHITU_LEDGER_URL: "postgres://user:pw@db.example:5432/app" };
    const { manifest } = await backup(remote, { out, cell: STOPPED });
    expect(manifest.ledgerUrlScheme).toBe("postgres");
    expect(manifest.notes.join(" ")).toContain("belongs to that provider");
    expect(manifest.members.some((m: { name: string }) => m.name === "ledger")).toBe(false);
  });
});

describe("backup: the hot path", () => {
  const snapshot = "backup_node_1_1785958596.sqlite";

  function withSnapshots() {
    const appBackups = join(data, "hiqlite", "state_machine", "backups");
    mkdirSync(appBackups, { recursive: true });
    writeFileSync(join(appBackups, snapshot), "APP-SNAPSHOT");
    writeFileSync(join(data, "rauthy", "db", "state_machine", "backups", snapshot), "IDP-SNAPSHOT");
  }

  it("captures the resource store before the chain", async () => {
    // The whole of the consistency answer (§3.2). The skew is unavoidable; its
    // DIRECTION is chosen, and this is the only place the choice is visible.
    withSnapshots();
    const fetchImpl = plane(snapshot);
    const { manifest } = await backup(
      { ...env(), ENRAHITU_OPERATOR_COOKIE: "session=s; csrf=c", ENRAHITU_RAUTHY_API_KEY: "k" },
      { out, cell: LIVE, online: true, fetchImpl },
    );
    const at = (name: string) =>
      manifest.members.find((m: { name: string }) => m.name === name)!.capturedAt;
    expect(new Date(at("state")).getTime()).toBeLessThanOrEqual(new Date(at("ledger")).getTime());
    expect(manifest.mode).toBe("hot");
  });

  it("reports the age of the identity snapshot it ships without an API key", async () => {
    // §3.6: an operator who has not configured a key is told what they actually
    // have, rather than being handed a stale member silently.
    withSnapshots();
    const fetchImpl = plane(snapshot);
    const { manifest } = await backup(
      { ...env(), ENRAHITU_OPERATOR_COOKIE: "session=s; csrf=c" },
      { out, cell: LIVE, online: true, fetchImpl },
    );
    expect(manifest.notes.join(" ")).toContain("no rauthy API key");
    expect(manifest.notes.join(" ")).toContain("old");
    expect(manifest.members.some((m: { name: string }) => m.name === "rauthy")).toBe(true);
  });

  it("falls back to the addon's own snapshot without an operator session", async () => {
    withSnapshots();
    const { manifest } = await backup(env(), { out, cell: LIVE, online: true });
    expect(manifest.notes.join(" ")).toContain("no operator session");
    // Never omitted and never silently stale.
    expect(manifest.members.some((m: { name: string }) => m.name === "state")).toBe(true);
  });

  it("refuses --online against a stopped cell", async () => {
    await expect(backup(env(), { out, cell: STOPPED, online: true })).rejects.toThrow(
      /nothing is answering/,
    );
  });
});

describe("restore", () => {
  it("puts a cold archive back and strips the previous owner's coordination files", async () => {
    const { destination } = await backup(env(), { out, cell: STOPPED });
    const target = mkdtempSync(join(tmpdir(), "enrahitu-target-"));
    const ledger = `file:${join(target, "ledger", "enrahitu.db")}`;
    const { applied } = await restore(
      { ENRAHITU_DATA_DIR: target, ENRAHITU_LEDGER_URL: ledger } as NodeJS.ProcessEnv,
      { from: destination, cell: STOPPED },
    );
    expect(existsSync(join(target, "ledger", "enrahitu.db"))).toBe(true);
    expect(readFileSync(join(target, "hiqlite", "state_machine", "db"), "utf8")).toBe("RAFT-STATE");
    expect(readFileSync(join(target, "keys", "access-private.pem"), "utf8")).toBe("PRIVATE");
    // A restored volume has no previous owner: the lock is never released by
    // the addon, so a cold copy always contains one.
    expect(existsSync(join(target, "hiqlite", "state_machine", "lock"))).toBe(false);
    expect(existsSync(join(target, "hiqlite", "enrahitu-owner.json"))).toBe(false);
    expect(applied.join(" ")).toContain("raft directory");
    rmSync(target, { recursive: true, force: true });
  });

  it("refuses a tampered archive before the volume is modified", async () => {
    // §4 item 4. The ordering is the guarantee: a restore that half-succeeded
    // leaves a state nothing has a name for.
    const { destination } = await backup(env(), { out, cell: STOPPED });
    const target = mkdtempSync(join(tmpdir(), "enrahitu-target-"));
    const scratch = mkdtempSync(join(tmpdir(), "enrahitu-tamper-"));
    execFileSync("tar", ["-xzf", destination, "-C", scratch]);
    writeFileSync(join(scratch, "keys", "access-private.pem"), "TAMPERED");
    execFileSync("tar", ["-czf", destination, "-C", scratch, "."]);

    await expect(
      restore({ ENRAHITU_DATA_DIR: target } as NodeJS.ProcessEnv, {
        from: destination,
        cell: STOPPED,
      }),
    ).rejects.toThrow(/does not match its manifest/);
    expect(existsSync(join(target, "keys"))).toBe(false);
    rmSync(target, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it("refuses a live cell", async () => {
    const { destination } = await backup(env(), { out, cell: STOPPED });
    await expect(
      restore(env(), { from: destination, cell: LIVE }),
    ).rejects.toThrow(/corruption rather than recovery/);
  });

  it("stages a hot archive's snapshots and names the variable that arms each", async () => {
    // §3.3: the hiqlite stores are restored through hiqlite's own documented
    // path, and the single-shot machinery spec 033 built is what applies it.
    const appBackups = join(data, "hiqlite", "state_machine", "backups");
    mkdirSync(appBackups, { recursive: true });
    writeFileSync(join(appBackups, "backup_node_1_1.sqlite"), "APP-SNAPSHOT");
    writeFileSync(
      join(data, "rauthy", "db", "state_machine", "backups", "backup_node_1_1.sqlite"),
      "IDP-SNAPSHOT",
    );
    const fetchImpl = plane("backup_node_1_1.sqlite");
    const { destination } = await backup(
      { ...env(), ENRAHITU_OPERATOR_COOKIE: "session=s; csrf=c", ENRAHITU_RAUTHY_API_KEY: "k" },
      { out, cell: LIVE, online: true, fetchImpl },
    );

    const target = mkdtempSync(join(tmpdir(), "enrahitu-target-"));
    const { applied } = await restore(
      { ENRAHITU_DATA_DIR: target, ENRAHITU_LEDGER_URL: `file:${join(target, "l.db")}` } as NodeJS.ProcessEnv,
      { from: destination, cell: STOPPED },
    );
    expect(readFileSync(join(target, "restore", "state.sqlite"), "utf8")).toBe("APP-SNAPSHOT");
    expect(readFileSync(join(target, "restore", "rauthy.sqlite"), "utf8")).toBe("IDP-SNAPSHOT");
    expect(applied.join(" ")).toContain("ENRAHITU_RESTORE_APP=file:");
    expect(applied.join(" ")).toContain("ENRAHITU_RESTORE_RAUTHY=file:");
    rmSync(target, { recursive: true, force: true });
  });

  it("warns that migrations are pending when the model hash differs", async () => {
    const { destination } = await backup(env(), { out, cell: STOPPED });
    const target = mkdtempSync(join(tmpdir(), "enrahitu-target-"));
    const { warnings } = await restore(
      { ENRAHITU_DATA_DIR: target, ENRAHITU_LEDGER_URL: `file:${join(target, "l.db")}` } as NodeJS.ProcessEnv,
      { from: destination, cell: STOPPED },
    );
    // The archive carries sha256:aaa; this image's app-model.json does not.
    expect(warnings.join(" ")).toContain("migrations are pending");
    rmSync(target, { recursive: true, force: true });
  });

  it("treats an unlisted file as disqualifying, not merely unknown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "enrahitu-verify-"));
    writeFileSync(join(dir, "stowaway"), "x");
    const problems = await verifyMembers(dir, { files: [] });
    expect(problems.join(" ")).toContain("not named in the manifest");
    rmSync(dir, { recursive: true, force: true });
  });
});
