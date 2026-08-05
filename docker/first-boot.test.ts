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
    const out = runFirstBoot({ ENRAHITU_RESTORE_RAUTHY: "s3:backup-2026-07-01" });
    expect(out).toContain("restore requested");
    expect(restoreEnv()).toContain("export ENRAHITU_RESTORE_RAUTHY=");
    expect(restoreEnv()).toContain("s3:backup-2026-07-01");
    expect(marker().rauthy.backup).toBe("s3:backup-2026-07-01");
  });

  // The whole point: the operator may leave the variable set forever.
  it("refuses to re-apply the same backup on later boots", () => {
    runFirstBoot({ ENRAHITU_RESTORE_RAUTHY: "s3:backup-2026-07-01" });
    const applied = marker().rauthy.appliedAt;

    for (const _ of [1, 2, 3]) {
      const out = runFirstBoot({ ENRAHITU_RESTORE_RAUTHY: "s3:backup-2026-07-01" });
      expect(out).toContain("already applied");
      expect(restoreEnv()).toContain("unset ENRAHITU_RESTORE_RAUTHY");
    }
    // The original decision is untouched, so the audit trail survives restarts.
    expect(marker().rauthy.appliedAt).toBe(applied);
  });

  // A different identifier is a NEW restore, not a repeat of the old one.
  it("honours a request for a different backup", () => {
    runFirstBoot({ ENRAHITU_RESTORE_RAUTHY: "s3:backup-2026-07-01" });
    const out = runFirstBoot({ ENRAHITU_RESTORE_RAUTHY: "s3:backup-2026-07-02" });
    expect(out).toContain("restore requested");
    expect(restoreEnv()).toContain("s3:backup-2026-07-02");
    expect(marker().rauthy.backup).toBe("s3:backup-2026-07-02");
    // The superseded decision is retained rather than overwritten blindly.
    expect(marker().rauthy.previous.backup).toBe("s3:backup-2026-07-01");
  });

  it("writes an unset for every store when no restore is requested", () => {
    runFirstBoot();
    expect(restoreEnv()).toBe("unset ENRAHITU_RESTORE_RAUTHY\nunset ENRAHITU_RESTORE_APP\n");
  });

  // A stale decision from a previous boot must not leak into a boot that did
  // not ask for one, which is what makes the file safe to source unconditionally.
  it("clears a previous boot's decision when the variable is removed", () => {
    runFirstBoot({ ENRAHITU_RESTORE_RAUTHY: "s3:backup-2026-07-01" });
    expect(restoreEnv()).toContain("export ENRAHITU_RESTORE_RAUTHY=");
    runFirstBoot();
    expect(restoreEnv()).toContain("unset ENRAHITU_RESTORE_RAUTHY");
    expect(restoreEnv()).not.toContain("export ");
  });

  // Operator-supplied text is sourced by bash, so it is quoted rather than
  // interpolated. A single quote in the identifier must not end the string.
  it("quotes an identifier containing a single quote", () => {
    runFirstBoot({ ENRAHITU_RESTORE_RAUTHY: "file:/tmp/o'brien.sqlite" });
    const line = restoreEnv()
      .split("\n")
      .find((l) => l.startsWith("export "))!;
    expect(line.startsWith("export ENRAHITU_RESTORE_RAUTHY=")).toBe(true);
    const value = execFileSync("bash", ["-c", `${line}; printf %s "$ENRAHITU_RESTORE_RAUTHY"`], {
      encoding: "utf8",
    });
    expect(value).toBe("file:/tmp/o'brien.sqlite");
  });

  it("re-applies when the marker is unreadable rather than refusing to boot", () => {
    runFirstBoot({ ENRAHITU_RESTORE_RAUTHY: "s3:backup-2026-07-01" });
    writeFileSync(join(data, "restore-applied.json"), "{ not json");
    const out = runFirstBoot({ ENRAHITU_RESTORE_RAUTHY: "s3:backup-2026-07-01" });
    expect(out).toContain("restore requested");
    expect(marker().rauthy.backup).toBe("s3:backup-2026-07-01");
  });
});

/**
 * One decision per store (spec 027 §3.3).
 *
 * The single-shot guard above was built for one ambient variable, which is the
 * defect §3.3 names: two independent hiqlite nodes read `HQL_BACKUP_RESTORE`,
 * and whichever one it was not meant for either refuses the file or accepts it.
 * These assertions are the bookkeeping half; the environment half is asserted in
 * `entrypoint.test.ts`, because the failure guarded there is inheritance.
 */
describe("first-boot: restore is per-store", () => {
  const restoreEnv = () => readFileSync(join(data, "restore.env"), "utf8");
  const marker = () => JSON.parse(readFileSync(join(data, "restore-applied.json"), "utf8"));

  it("records a decision per store and keeps them independent", () => {
    runFirstBoot({
      ENRAHITU_RESTORE_RAUTHY: "file:/data/restore/rauthy.sqlite",
      ENRAHITU_RESTORE_APP: "file:/data/restore/app.sqlite",
    });
    expect(marker().rauthy.backup).toBe("file:/data/restore/rauthy.sqlite");
    expect(marker().app.backup).toBe("file:/data/restore/app.sqlite");
    expect(restoreEnv()).toContain("export ENRAHITU_RESTORE_RAUTHY='file:/data/restore/rauthy.sqlite'");
    expect(restoreEnv()).toContain("export ENRAHITU_RESTORE_APP='file:/data/restore/app.sqlite'");
  });

  it("re-arms one store without re-applying the other", () => {
    // Restoring the identity store alone is an ordinary operation, and it must
    // not drag the resource store's already-applied snapshot back through.
    runFirstBoot({
      ENRAHITU_RESTORE_RAUTHY: "file:/data/restore/rauthy.sqlite",
      ENRAHITU_RESTORE_APP: "file:/data/restore/app.sqlite",
    });
    const appApplied = marker().app.appliedAt;
    const out = runFirstBoot({
      ENRAHITU_RESTORE_RAUTHY: "file:/data/restore/rauthy-2.sqlite",
      ENRAHITU_RESTORE_APP: "file:/data/restore/app.sqlite",
    });
    expect(out).toContain("restore requested for rauthy's identity store");
    expect(out).toContain("already applied");
    expect(restoreEnv()).toContain("export ENRAHITU_RESTORE_RAUTHY='file:/data/restore/rauthy-2.sqlite'");
    expect(restoreEnv()).toContain("unset ENRAHITU_RESTORE_APP");
    expect(marker().app.appliedAt).toBe(appApplied);
  });

  it("names an ambient HQL_BACKUP_RESTORE instead of guessing which node meant it", () => {
    // Honouring it would require choosing a store, and choosing wrong offers
    // rauthy's snapshot to the app's node. Refusing to boot is worse still: the
    // name is hiqlite's own, so an unrelated workload's variable would take this
    // container down. So it is reported, and the entrypoint scrubs it.
    const out = runFirstBoot({ HQL_BACKUP_RESTORE: "file:/data/restore/ambiguous.sqlite" });
    expect(out).toContain("HQL_BACKUP_RESTORE is set and is being ignored");
    expect(out).toContain("ENRAHITU_RESTORE_RAUTHY");
    expect(out).toContain("ENRAHITU_RESTORE_APP");
    expect(restoreEnv()).not.toContain("export ");
  });

  it("carries a pre-split marker forward rather than interpreting it", () => {
    // A marker written before the split recorded one decision for one ambient
    // variable and cannot say which store it meant. Guessing is the ambiguity
    // this change exists to end, so it is preserved and stepped over.
    writeFileSync(
      join(data, "restore-applied.json"),
      JSON.stringify({ backup: "s3:backup-2026-07-01", appliedAt: "2026-07-01T00:00:00.000Z" }),
    );
    runFirstBoot({ ENRAHITU_RESTORE_APP: "file:/data/restore/app.sqlite" });
    expect(marker().legacy.backup).toBe("s3:backup-2026-07-01");
    expect(marker().app.backup).toBe("file:/data/restore/app.sqlite");
    expect(marker().backup).toBeUndefined();
  });
});

describe("first-boot: the mail notice (spec 026 §3.2)", () => {
  it("names what is inert when no relay is configured", () => {
    // The failure this prevents is a silent one: rauthy treats mail as optional
    // and degrades quietly, so without this line the first sign that delivery
    // was never configured is a locked-out admin who cannot reset a password.
    const out = runFirstBoot({ ENRAHITU_SMTP_URL: "" });
    expect(out).toContain("no ENRAHITU_SMTP_URL");
    for (const flow of ["password reset", "email verification", "registration", "invitation"]) {
      expect(out).toContain(flow);
    }
  });

  it("says nothing once a relay is configured", () => {
    const out = runFirstBoot({ ENRAHITU_SMTP_URL: "smtp.example.com" });
    expect(out).not.toContain("no ENRAHITU_SMTP_URL");
  });

  it("is a notice, not a failure: the container still provisions and boots", () => {
    // A local trial of the packaged image must keep working with no mail server.
    const out = runFirstBoot({ ENRAHITU_SMTP_URL: "" });
    expect(out).toContain("[first-boot] ready");
    expect(readFileSync(join(data, "keys", "metrics-token"), "utf8")).toHaveLength(48);
  });
});
