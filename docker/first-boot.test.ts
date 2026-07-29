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
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIRST_BOOT = join(HERE, "first-boot.mjs");

let data: string;

function runFirstBoot(extraEnv: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [FIRST_BOOT], {
    env: { ...process.env, ENRAHITU_DATA_DIR: data, ...extraEnv },
    encoding: "utf8",
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

/**
 * The single-shot restore guard (spec 033 §3.5, spec 032 §3.9).
 *
 * hiqlite applies HQL_BACKUP_RESTORE at boot, before the raft node starts, and
 * its own documentation says to remove the value afterwards. Left set in a
 * container with a restart policy it re-applies on every restart and discards
 * everything written since, so a crash loop becomes silent, repeated data loss.
 * These tests exist because that failure is invisible while it is happening:
 * the operator sees a container restarting, not a container deleting.
 *
 * The contract is the restore.env handshake. first-boot decides; the entrypoint
 * sources the decision before starting either supervised process.
 */
describe("first-boot: restore is single-shot", () => {
  const restoreEnv = () => readFileSync(join(data, "restore.env"), "utf8");
  const marker = () => JSON.parse(readFileSync(join(data, "restore-applied.json"), "utf8"));

  it("honours the request on the boot that asks for it", () => {
    const out = runFirstBoot({ HQL_BACKUP_RESTORE: "s3:backup-2026-07-01" });
    expect(out).toContain("restore requested");
    expect(restoreEnv()).toContain("export HQL_BACKUP_RESTORE=");
    expect(restoreEnv()).toContain("s3:backup-2026-07-01");
    expect(marker().backup).toBe("s3:backup-2026-07-01");
  });

  // The whole point: the operator may leave the variable set forever.
  it("refuses to re-apply the same backup on later boots", () => {
    runFirstBoot({ HQL_BACKUP_RESTORE: "s3:backup-2026-07-01" });
    const applied = marker().appliedAt;

    for (const _ of [1, 2, 3]) {
      const out = runFirstBoot({ HQL_BACKUP_RESTORE: "s3:backup-2026-07-01" });
      expect(out).toContain("already applied");
      expect(restoreEnv()).toBe("unset HQL_BACKUP_RESTORE\n");
    }
    // The original decision is untouched, so the audit trail survives restarts.
    expect(marker().appliedAt).toBe(applied);
  });

  // A different identifier is a NEW restore, not a repeat of the old one.
  it("honours a request for a different backup", () => {
    runFirstBoot({ HQL_BACKUP_RESTORE: "s3:backup-2026-07-01" });
    const out = runFirstBoot({ HQL_BACKUP_RESTORE: "s3:backup-2026-07-02" });
    expect(out).toContain("restore requested");
    expect(restoreEnv()).toContain("s3:backup-2026-07-02");
    expect(marker().backup).toBe("s3:backup-2026-07-02");
    // The superseded decision is retained rather than overwritten blindly.
    expect(marker().previous.backup).toBe("s3:backup-2026-07-01");
  });

  it("writes an unset when no restore is requested", () => {
    runFirstBoot();
    expect(restoreEnv()).toBe("unset HQL_BACKUP_RESTORE\n");
  });

  // A stale decision from a previous boot must not leak into a boot that did
  // not ask for one, which is what makes the file safe to source unconditionally.
  it("clears a previous boot's decision when the variable is removed", () => {
    runFirstBoot({ HQL_BACKUP_RESTORE: "s3:backup-2026-07-01" });
    expect(restoreEnv()).toContain("export HQL_BACKUP_RESTORE=");
    runFirstBoot();
    expect(restoreEnv()).toBe("unset HQL_BACKUP_RESTORE\n");
  });

  // Operator-supplied text is sourced by bash, so it is quoted rather than
  // interpolated. A single quote in the identifier must not end the string.
  it("quotes an identifier containing a single quote", () => {
    runFirstBoot({ HQL_BACKUP_RESTORE: "file:/tmp/o'brien.sqlite" });
    const line = restoreEnv().trim();
    expect(line.startsWith("export HQL_BACKUP_RESTORE=")).toBe(true);
    const value = execFileSync("bash", ["-c", `${line}; printf %s "$HQL_BACKUP_RESTORE"`], {
      encoding: "utf8",
    });
    expect(value).toBe("file:/tmp/o'brien.sqlite");
  });

  it("re-applies when the marker is unreadable rather than refusing to boot", () => {
    runFirstBoot({ HQL_BACKUP_RESTORE: "s3:backup-2026-07-01" });
    writeFileSync(join(data, "restore-applied.json"), "{ not json");
    const out = runFirstBoot({ HQL_BACKUP_RESTORE: "s3:backup-2026-07-01" });
    expect(out).toContain("restore requested");
    expect(marker().backup).toBe("s3:backup-2026-07-01");
  });
});
