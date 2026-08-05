#!/usr/bin/env node
/**
 * `restore`: put an archive back on a volume, or refuse before touching it
 * (spec 027 §3.3).
 *
 *   node scripts/ops/restore.mjs --from /secure/backups/enrahitu-backup-...tar.gz
 *
 * The order of operations is the guarantee. Every checksum in the manifest is
 * verified against the extracted members BEFORE anything on the volume is
 * modified, so a tampered or truncated archive is refused with the volume
 * exactly as it was. A restore that half-succeeded would be worse than one that
 * never started, because the state it leaves behind is a state nothing has a
 * name for.
 *
 * ## Two shapes of hiqlite member, and the fork is real
 *
 * §3.3 says both hiqlite stores are restored "through hiqlite's own documented
 * path rather than by file placement": `HQL_BACKUP_RESTORE=file:<path>` on the
 * next start, validated against the `_metadata` table. That is exactly right for
 * a HOT archive, whose hiqlite members are snapshot files produced by
 * `backup()`.
 *
 * A COLD archive's members are not snapshot files. They are the raft directories
 * themselves, and §3.2's cold-mode argument is precisely that a stopped node's
 * directory IS the state it would recover from. There is no backup file to hand
 * `HQL_BACKUP_RESTORE`, and manufacturing one would discard the very property
 * that makes a cold copy correct. So a cold member is placed as a directory and
 * a hot member is staged and armed, and the verb reports which it did.
 *
 * This fork is not in §3.3 because §3.3 was written when the app's hiqlite was
 * to be "recreated empty" and the 2026-08-04 amendment that made it a restored
 * member did not revisit the sentence. §3.10 records it.
 *
 * ## What is stripped on the way in
 *
 * `state_machine/lock` and `enrahitu-owner.json` are coordination artifacts, not
 * data. The lock is never released, because the addon exposes no `shutdown()`
 * (spec 002, amendment 2026-07-30), so every cold copy contains one; the owner
 * record names the node and pid namespace that held it. Restored verbatim into a
 * new cell they describe a process that does not exist, and the reclaim logic
 * would have to prove them stale before the store opens. Dropping them is the
 * honest move: a restored volume has no previous owner.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_DATA_DIR,
  MEMBERS,
  cellIsRunning,
  extractArchive,
  readManifest,
  sha256File,
} from "./archive.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const DEFAULT_LEDGER_URL = "file:./.data/ledger/enrahitu.db";

/** Runtime coordination artifacts that must not outlive the cell that wrote them. */
const STRIPPED = ["enrahitu-owner.json", join("state_machine", "lock")];

/**
 * Verify every file the manifest lists, and refuse the whole archive on the
 * first mismatch (§3.3, §4 item 4).
 *
 * A missing file counts as a mismatch. An archive that lost a member in transit
 * is not a partial archive to be applied partially; it is an archive whose
 * manifest no longer describes it.
 */
export async function verifyMembers(dir, manifest) {
  const problems = [];
  for (const entry of manifest.files ?? []) {
    const path = join(dir, entry.path);
    if (!existsSync(path)) {
      problems.push(`${entry.path}: named in the manifest and absent from the archive`);
      continue;
    }
    const actual = await sha256File(path);
    if (actual !== entry.sha256) {
      problems.push(`${entry.path}: expected ${entry.sha256}, found ${actual}`);
    }
  }
  // A file the manifest does not name is as disqualifying as a corrupted one:
  // it is content nobody signed for, arriving inside an artifact whose whole
  // claim is that its contents are known.
  const named = new Set((manifest.files ?? []).map((f) => f.path));
  for (const rel of walk(dir)) {
    if (rel === "manifest.json") continue;
    if (!named.has(rel)) problems.push(`${rel}: present in the archive and not named in the manifest`);
  }
  return problems;
}

function walk(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** Is this member a hiqlite snapshot file, or a raft directory? */
export function memberShape(dir, member) {
  const root = join(dir, MEMBERS[member] ?? member);
  if (!existsSync(root)) return "absent";
  const entries = readdirSync(root, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile());
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 0 && files.every((f) => f.name.endsWith(".sqlite"))) return "snapshot";
  return "directory";
}

function copyTree(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  execFileSync("cp", ["-R", "-p", from, to], { stdio: "pipe" });
}

function stripArtifacts(root) {
  for (const rel of STRIPPED) {
    rmSync(join(root, rel), { force: true, recursive: true });
  }
}

/** Every regular file under a tree, chmod 0600. */
function lockDown(root) {
  for (const rel of walk(root)) chmodSync(join(root, rel), 0o600);
}

export async function restore(env = process.env, opts = {}) {
  const archive = opts.from;
  if (!archive) throw new Error("--from <archive> is required");
  const dataDir = env.ENRAHITU_DATA_DIR || DEFAULT_DATA_DIR;

  const live = opts.cell ?? (await cellIsRunning(env));
  if (live.running) {
    throw new Error(
      `a cell is answering on ${live.host}:${live.port}. A restore replaces the volume under a ` +
        `running process, which is corruption rather than recovery. Stop the container first.`,
    );
  }

  const staging = mkdtempSync(join(tmpdir(), "enrahitu-restore-"));
  const applied = [];
  const warnings = [];
  try {
    extractArchive(archive, staging);
    const manifest = await readManifest(staging);

    // Nothing on the volume has been touched at this point, and nothing is
    // until every member verifies.
    const problems = await verifyMembers(staging, manifest);
    if (problems.length > 0) {
      throw new Error(
        `the archive does not match its manifest, so nothing was restored:\n  ` +
          problems.join("\n  "),
      );
    }

    // A v1 backup into a v2 image is legitimate and common; it means pending
    // migrations, and the migrate verb is the next step rather than an implicit
    // one (§3.3).
    const imageModelHash = await imageModel();
    if (manifest.modelHash && imageModelHash && manifest.modelHash !== imageModelHash) {
      warnings.push(
        `the archive was taken under model ${manifest.modelHash} and this image runs ` +
          `${imageModelHash}. That is a legitimate upgrade restore, and it means migrations are ` +
          `pending: run the migrate verb after the cell starts.`,
      );
    }

    mkdirSync(dataDir, { recursive: true });

    // CoreLedger: placed as the database file (§3.3).
    const ledgerDir = join(staging, MEMBERS.ledger);
    if (existsSync(ledgerDir)) {
      const url = env.ENRAHITU_LEDGER_URL || DEFAULT_LEDGER_URL;
      if (!url.startsWith("file:")) {
        warnings.push(
          `the archive carries a CoreLedger member but ENRAHITU_LEDGER_URL is ${url}, which is ` +
            `not a file on this volume. The ledger member was NOT restored; point the cell at a ` +
            `file: ledger, or restore it into the provider that owns it.`,
        );
      } else {
        const target = url.slice("file:".length);
        mkdirSync(dirname(target), { recursive: true });
        for (const name of readdirSync(ledgerDir)) {
          // The archive's basename may differ from this deployment's, so the
          // suffix travels and the stem is taken from the configured URL.
          const suffix = name.endsWith("-wal") ? "-wal" : name.endsWith("-shm") ? "-shm" : "";
          copyTree(join(ledgerDir, name), target + suffix);
        }
        applied.push(`ledger: placed at ${target}`);
      }
    }

    // The two hiqlite stores, each by the shape its archive carries.
    for (const [member, storeDir, variable, label] of [
      ["state", join(dataDir, "hiqlite"), "ENRAHITU_RESTORE_APP", "the app's resource store"],
      ["rauthy", join(dataDir, "rauthy", "db"), "ENRAHITU_RESTORE_RAUTHY", "rauthy's identity store"],
    ]) {
      const shape = memberShape(staging, member);
      if (shape === "absent") continue;
      const source = join(staging, MEMBERS[member]);
      if (shape === "directory") {
        rmSync(storeDir, { recursive: true, force: true });
        copyTree(source, storeDir);
        stripArtifacts(storeDir);
        applied.push(`${member}: ${label} placed at ${storeDir} (cold member, a raft directory)`);
      } else {
        const staged = join(dataDir, "restore");
        mkdirSync(staged, { recursive: true });
        const snapshot = readdirSync(source).find((n) => n.endsWith(".sqlite"));
        const target = join(staged, `${member}.sqlite`);
        copyTree(join(source, snapshot), target);
        chmodSync(target, 0o600);
        applied.push(
          `${member}: ${label} staged at ${target}. Set ${variable}=file:${target} on the next ` +
            `start; first-boot applies it exactly once and records that it did.`,
        );
      }
    }

    // Key material, written back at 0600 (§3.3). Either encrypted store restored
    // without its matching keys is undecryptable, which is why it is in the
    // archive at all. It is one class across two directories, so it goes back to
    // both: the app's PEM material to /data/keys, rauthy's secrets and admin
    // password beside its store.
    const keys = join(staging, MEMBERS.keys);
    if (existsSync(keys)) {
      if (existsSync(join(keys, "app"))) {
        const target = join(dataDir, "keys");
        rmSync(target, { recursive: true, force: true });
        copyTree(join(keys, "app"), target);
        lockDown(target);
        applied.push(`keys: placed at ${target}, mode 0600`);
      }
      const rauthyKeys = join(keys, "rauthy");
      if (existsSync(rauthyKeys)) {
        for (const name of readdirSync(rauthyKeys)) {
          const target = join(dataDir, "rauthy", name);
          mkdirSync(dirname(target), { recursive: true });
          copyTree(join(rauthyKeys, name), target);
          chmodSync(target, 0o600);
        }
        applied.push(`keys: rauthy's secrets placed under ${join(dataDir, "rauthy")}, mode 0600`);
      }
    } else {
      warnings.push(
        `this archive carries no key material. rauthy's store and the app's snapshots are both ` +
          `encrypted at rest, so without the matching keys neither can be opened.`,
      );
    }

    return { manifest, applied, warnings };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * The model hash of the image running this verb, for the upgrade warning.
 *
 * Read from the model's own `integrity.hash` rather than computed over the
 * file's bytes. The model's identity is a canonical hash
 * (`sha256-canonical-keysort-v1`, spec 020) that the extractor produces and the
 * kernel boots on, so a digest of the serialized file is a different number that
 * happens to be the same length. A verb that compared that number against the
 * archive's would warn about pending migrations on every restore, including the
 * ones into the identical image.
 *
 * Absent or unreadable, the comparison is skipped rather than guessed: a
 * warning nobody can act on is worse than no warning.
 */
async function imageModel(root = repoRoot) {
  try {
    const { readFile } = await import("node:fs/promises");
    const model = JSON.parse(await readFile(join(root, "app-model.json"), "utf8"));
    return model.integrity?.hash ?? null;
  } catch {
    return null;
  }
}

const invokedDirectly =
  import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const fromIdx = argv.indexOf("--from");
  const from = fromIdx >= 0 ? argv[fromIdx + 1] : undefined;
  try {
    const { manifest, applied, warnings } = await restore(process.env, { from });
    console.log(`[restore] ${manifest.mode} archive taken ${manifest.createdAt}, every member verified`);
    for (const line of applied) console.log(`[restore] ${line}`);
    for (const warning of warnings) console.warn(`[restore] warning: ${warning}`);
  } catch (err) {
    console.error(`[restore] refusing: ${err.message}`);
    process.exit(1);
  }
}
