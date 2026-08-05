#!/usr/bin/env node
/**
 * `backup`: one artifact holding every class of state on the volume
 * (spec 027 §3.1-§3.2, §3.6).
 *
 *   node scripts/ops/backup.mjs --out /secure/backups     # cold, the default
 *   node scripts/ops/backup.mjs --online --out /secure/backups
 *
 * Two modes, because the honest default and the zero-downtime path are
 * different tools, not two settings of one.
 *
 * **Cold** is a stopped container. Every class is at rest, so each is copied
 * directly, and the copy of `/data/hiqlite` is safe here and only here: a
 * stopped node's raft directory is exactly the state it would recover from on
 * its next boot, including after an unclean stop, which is the only useful
 * definition of "at rest". The same copy taken while the node runs captures a
 * raft log mid-write.
 *
 * **Hot** (`--online`) is a running container, and every class is captured by
 * the process that owns it: CoreLedger through `VACUUM INTO`, the app's hiqlite
 * through the admin plane's operator-gated endpoint, rauthy through its own
 * `POST /auth/v1/backup`. Nothing is copied around a live writer.
 *
 * ## The order is the consistency answer
 *
 * Three stores are snapshotted at three instants and nothing can make them one:
 * three processes, three write paths, no shared transaction. The skew is not
 * symmetric, because the Decision chain lives in CoreLedger and the resources
 * those Decisions admit live in hiqlite:
 *
 * - chain captured AFTER the resource store: the chain may hold a Decision
 *   admitting a write the resource member does not contain. Visible, and the
 *   chain still verifies.
 * - chain captured BEFORE it: the resource member may hold a row whose
 *   admitting Decision is absent. That is an unaudited row, the single thing the
 *   kernel plane exists to prevent, and nothing about the row says a record
 *   should have existed.
 *
 * So the resource store is captured first and the chain last, which puts the
 * skew permanently in the direction that is detectable. The manifest records a
 * captured-at instant per member so the ordering is auditable after the fact
 * rather than merely promised. An operator who needs zero skew takes a cold
 * backup.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import { adminRequest, appUrl } from "./admin-plane.mjs";
import {
  DEFAULT_DATA_DIR,
  MEMBERS,
  assertPrivateDirectory,
  cellIsRunning,
  chainHashes,
  ledgerIsLocal,
  ledgerScheme,
  sha256File,
  writeArchive,
  writeManifest,
} from "./archive.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const DEFAULT_LEDGER_URL = "file:./.data/ledger/enrahitu.db";

/**
 * Where hiqlite writes a local snapshot, established by running it: the addon
 * puts them under `<data_dir>/state_machine/backups` and names them
 * `backup_node_<id>_<epoch>.sqlite`. Neither is documented, so both are
 * discovered rather than assumed: the path below is where the search starts and
 * a recursive fallback finds the file if a future version moves it.
 */
const BACKUP_SUBDIR = join("state_machine", "backups");

const now = () => new Date().toISOString();

/** Every file under `dir`, relative to it, sorted for a deterministic manifest. */
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

/** Copy a tree, preserving modes so key material stays 0600 inside the archive. */
function copyTree(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  execFileSync("cp", ["-R", "-p", from, to], { stdio: "pipe" });
}

/** The newest `backup_node_*.sqlite` under a store's data directory. */
function newestSnapshot(dataDir) {
  const dir = join(dataDir, BACKUP_SUBDIR);
  const candidates = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".sqlite"))
        .map((name) => ({ name, path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
    : [];
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.mtime - a.mtime)[0];
}

/** Locate a named snapshot, falling back to a search if the layout moved. */
function findSnapshot(dataDir, name) {
  const direct = join(dataDir, BACKUP_SUBDIR, name);
  if (existsSync(direct)) return direct;
  const found = walk(dataDir).find((rel) => basename(rel) === name);
  return found ? join(dataDir, found) : null;
}

/** How old a snapshot is, in the words §3.6 asks the verb to report. */
function ageOf(path) {
  const ms = Date.now() - statSync(path).mtimeMs;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute old";
  if (minutes < 120) return `${minutes} minute(s) old`;
  return `${Math.round(minutes / 60)} hour(s) old`;
}

// --- the three hot captures -------------------------------------------------

/**
 * The app's resource store, through the admin plane (§3.2).
 *
 * Not through a file copy and not through a second process: at N=1 the embedded
 * node holds the volume open, so nothing outside the app can reach the store.
 *
 * A missing operator session is a degradation and not a failure. The store falls
 * back to the most recent snapshot the addon already wrote and the verb reports
 * its age, so an operator who has not configured a session is told what they
 * actually have. It is never omitted and never silently stale (§3.6).
 */
export async function captureState(env, { fetchImpl = fetch } = {}) {
  const dataDir = env.ENRAHITU_HIQ_DATA_DIR || join(env.ENRAHITU_DATA_DIR || DEFAULT_DATA_DIR, "hiqlite");
  const cookie = env.ENRAHITU_OPERATOR_COOKIE;

  if (!cookie) {
    const fallback = newestSnapshot(dataDir);
    if (!fallback) {
      return {
        error:
          "no operator session (ENRAHITU_OPERATOR_COOKIE) and no snapshot on the volume to fall " +
          "back to. The app's resource store cannot be captured hot without one; take a cold backup.",
      };
    }
    return {
      path: fallback.path,
      capturedAt: new Date(statSync(fallback.path).mtimeMs).toISOString(),
      note:
        `no operator session (ENRAHITU_OPERATOR_COOKIE): shipping the snapshot the addon already ` +
        `wrote, ${ageOf(fallback.path)}`,
    };
  }

  const body = await adminRequest(env, "/api/admin/state/backups", { method: "POST", fetchImpl });
  if (!body.name) throw new Error("the admin plane reported no snapshot file");
  const path = findSnapshot(dataDir, body.name);
  if (!path) {
    throw new Error(`the admin plane named ${body.name} but it is not under ${dataDir}`);
  }
  return {
    path,
    capturedAt: now(),
    note: body.fresh
      ? undefined
      : `the addon's sixty-second duplicate guard answered with an existing snapshot, ${ageOf(path)}`,
  };
}

/**
 * rauthy's identity store, through rauthy (§3.1).
 *
 * Its own mechanism produces a plain SQLite file carrying a `_metadata` table
 * that rauthy validates on restore, so the identity store is captured by the
 * process that owns it with an integrity check this substrate did not have to
 * invent. Copying `/data/rauthy/db` directly would capture a raft log mid-write.
 *
 * Without an API key the identity snapshot is as of rauthy's own cron run, up
 * to 24 hours by default, and the verb reports that age rather than shipping a
 * stale member silently.
 */
export async function captureRauthy(env, { fetchImpl = fetch } = {}) {
  const dataDir = join(env.ENRAHITU_DATA_DIR || DEFAULT_DATA_DIR, "rauthy", "db");
  const apiKey = env.ENRAHITU_RAUTHY_API_KEY;

  if (!apiKey) {
    const fallback = newestSnapshot(dataDir);
    if (!fallback) {
      return {
        error:
          "no rauthy API key (ENRAHITU_RAUTHY_API_KEY) and no snapshot rauthy has written yet. " +
          "The identity store cannot be captured hot without one; take a cold backup.",
      };
    }
    return {
      path: fallback.path,
      capturedAt: new Date(statSync(fallback.path).mtimeMs).toISOString(),
      note:
        `no rauthy API key (ENRAHITU_RAUTHY_API_KEY): shipping rauthy's own cron snapshot, ` +
        `${ageOf(fallback.path)}`,
    };
  }

  const res = await fetchImpl(`${appUrl(env)}/auth/v1/backup`, {
    method: "POST",
    headers: { authorization: `API-Key ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`rauthy refused the backup request (${res.status})`);
  }
  // rauthy answers the request and writes asynchronously; the newest file on
  // its volume after the call is the one it just wrote.
  const snapshot = newestSnapshot(dataDir);
  if (!snapshot) throw new Error(`rauthy reported success but wrote no snapshot under ${dataDir}`);
  return { path: snapshot.path, capturedAt: now() };
}

/**
 * CoreLedger, through `VACUUM INTO` (§3.1).
 *
 * A consistent, fully-checkpointed copy of a live database without stopping
 * writers, which is exactly the primitive needed and the only class the
 * substrate snapshots itself.
 *
 * A remote ledger is named, detected, and delegated: the authoritative copy is
 * not on this volume and its backup belongs to that provider. The chain hashes
 * are still read, because a client can query a remote ledger even though it
 * cannot vacuum one to a local path.
 */
export async function captureLedger(env, stageDir) {
  const url = env.ENRAHITU_LEDGER_URL || DEFAULT_LEDGER_URL;
  const scheme = ledgerScheme(url);
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url });
  try {
    const hashes = await chainHashes(client);
    if (!ledgerIsLocal(url)) {
      return {
        ...hashes,
        scheme,
        note:
          `the ledger is ${scheme}: its authoritative copy is not on this volume and its backup ` +
          `belongs to that provider. Nothing of it is in this archive.`,
      };
    }
    const target = join(stageDir, MEMBERS.ledger, "enrahitu.db");
    mkdirSync(dirname(target), { recursive: true });
    await client.execute(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    return { ...hashes, scheme, path: target, capturedAt: now() };
  } finally {
    client.close();
  }
}

// --- the verb ---------------------------------------------------------------

export async function backup(env = process.env, opts = {}) {
  const online = opts.online ?? false;
  const dataDir = env.ENRAHITU_DATA_DIR || DEFAULT_DATA_DIR;
  const outDir = opts.out ?? ".";
  assertPrivateDirectory(outDir);

  const live = opts.cell ?? (await cellIsRunning(env));
  if (!online && live.running) {
    throw new Error(
      `a cell is answering on ${live.host}:${live.port}. A cold backup is defined by the ` +
        `container being stopped: copying a live raft log captures it mid-write, and the archive ` +
        `would restore, the container would start, and the damage would surface later. Stop the ` +
        `container, or take a hot backup with --online.`,
    );
  }
  if (online && !live.running) {
    throw new Error(
      `--online was asked for but nothing is answering on ${live.host}:${live.port}. A hot backup ` +
        `is taken by the running processes that own each store; with the cell stopped, a cold ` +
        `backup is both correct and simpler.`,
    );
  }

  const stage = mkdtempSync(join(tmpdir(), "enrahitu-backup-"));
  const members = [];
  const notes = [];
  try {
    let hashes = { modelHash: null, gateConfigHash: null };
    let scheme = null;

    if (online) {
      // Resource store first, chain last (§3.2). The order is the design.
      const state = await captureState(env, opts);
      if (state.error) notes.push(`state: ${state.error}`);
      else {
        copyTree(state.path, join(stage, MEMBERS.state, basename(state.path)));
        members.push({ name: "state", capturedAt: state.capturedAt, note: state.note });
        if (state.note) notes.push(`state: ${state.note}`);
      }

      const rauthy = await captureRauthy(env, opts);
      if (rauthy.error) notes.push(`rauthy: ${rauthy.error}`);
      else {
        copyTree(rauthy.path, join(stage, MEMBERS.rauthy, basename(rauthy.path)));
        members.push({ name: "rauthy", capturedAt: rauthy.capturedAt, note: rauthy.note });
        if (rauthy.note) notes.push(`rauthy: ${rauthy.note}`);
      }

      const ledger = await captureLedger(env, stage);
      hashes = { modelHash: ledger.modelHash, gateConfigHash: ledger.gateConfigHash };
      scheme = ledger.scheme;
      if (ledger.path) members.push({ name: "ledger", capturedAt: ledger.capturedAt });
      if (ledger.note) notes.push(`ledger: ${ledger.note}`);
    } else {
      // Cold: every class is at rest, so each is copied where it lies.
      const ledgerUrl = env.ENRAHITU_LEDGER_URL || DEFAULT_LEDGER_URL;
      scheme = ledgerScheme(ledgerUrl);
      if (ledgerIsLocal(ledgerUrl)) {
        const file = ledgerUrl.slice("file:".length);
        if (existsSync(file)) {
          // The WAL and shared-memory files travel with the database: a stopped
          // SQLite may hold committed transactions in the WAL, and a database
          // copied without it is a database missing its most recent writes.
          for (const suffix of ["", "-wal", "-shm"]) {
            if (existsSync(file + suffix)) {
              copyTree(file + suffix, join(stage, MEMBERS.ledger, basename(file) + suffix));
            }
          }
          members.push({ name: "ledger", capturedAt: now() });
          const { createClient } = await import("@libsql/client");
          const client = createClient({ url: ledgerUrl });
          try {
            hashes = await chainHashes(client);
          } finally {
            client.close();
          }
        } else {
          notes.push(`ledger: ${file} does not exist yet; nothing of it is in this archive`);
        }
      } else {
        notes.push(
          `ledger: the ledger is ${scheme}: its authoritative copy is not on this volume and its ` +
            `backup belongs to that provider. Nothing of it is in this archive.`,
        );
      }

      // The stores only. Key material is class four and is collected below for
      // both modes, because the classes are what the archive is organised by
      // (§3.1) and `/data/rauthy` holds two of them.
      for (const [name, source] of [
        ["state", join(dataDir, "hiqlite")],
        ["rauthy", join(dataDir, "rauthy", "db")],
      ]) {
        if (!existsSync(source)) {
          notes.push(`${name}: ${source} does not exist; nothing of it is in this archive`);
          continue;
        }
        copyTree(source, join(stage, MEMBERS[name]));
        members.push({ name, capturedAt: now() });
      }
    }

    // Key material binds the archive together (§3.1), in both modes and for the
    // same reason: rauthy encrypts its store with ENC_KEYS and the app encrypts
    // its snapshots with ENRAHITU_HIQ_ENC_KEYS, both living in secrets.env, so
    // either store restored without its matching keys is undecryptable. It is
    // one class spread across two directories, which is why it is gathered here
    // rather than falling out of a directory copy.
    const keyStage = join(stage, MEMBERS.keys);
    let keyFiles = 0;
    if (existsSync(join(dataDir, "keys"))) {
      copyTree(join(dataDir, "keys"), join(keyStage, "app"));
      keyFiles += 1;
    }
    for (const name of ["secrets.env", "admin-password"]) {
      const file = join(dataDir, "rauthy", name);
      if (existsSync(file)) {
        copyTree(file, join(keyStage, "rauthy", name));
        keyFiles += 1;
      }
    }
    if (keyFiles > 0) members.push({ name: "keys", capturedAt: now() });
    else notes.push("keys: no key material on this volume; a restored store could not be opened");

    // Per-file checksums, which is what makes a tampered archive refusable
    // before the volume is touched, plus a per-member rollup.
    const files = [];
    for (const rel of walk(stage)) {
      files.push({ path: rel, sha256: await sha256File(join(stage, rel)) });
    }
    for (const member of members) {
      const own = files.filter((f) => f.path.startsWith(`${MEMBERS[member.name]}/`));
      member.files = own.map((f) => f.path);
      member.sha256 = await rollup(own);
    }

    const manifest = {
      template: await templateVersions(),
      modelHash: hashes.modelHash,
      gateConfigHash: hashes.gateConfigHash,
      ledgerUrlScheme: scheme,
      mode: online ? "hot" : "cold",
      createdAt: now(),
      members,
      files,
      notes,
    };
    await writeManifest(stage, manifest);

    const stamp = manifest.createdAt.replace(/[:.]/g, "-");
    const destination = opts.destination ?? join(outDir, `enrahitu-backup-${stamp}.tar.gz`);
    writeArchive(stage, destination);
    return { destination, manifest };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** A member's rollup: a digest over its sorted (path, sha256) pairs. */
async function rollup(files) {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.path}\0${file.sha256}\n`);
  return `sha256:${hash.digest("hex")}`;
}

/** The template and contract versions, read from the contract itself. */
async function templateVersions(root = repoRoot) {
  try {
    const toml = await readFile(join(root, "template.toml"), "utf8");
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
    const versions = [...toml.matchAll(/^\s*version\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
    return { name, version: versions[0] ?? null, contract: versions[1] ?? null };
  } catch {
    return { name: null, version: null, contract: null };
  }
}

const invokedDirectly =
  import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const online = argv.includes("--online");
  const outIdx = argv.indexOf("--out");
  const out = outIdx >= 0 ? argv[outIdx + 1] : ".";
  try {
    const { destination, manifest } = await backup(process.env, { online, out });
    for (const note of manifest.notes) console.log(`[backup] note: ${note}`);
    for (const member of manifest.members) {
      console.log(`[backup] ${member.name.padEnd(7)} captured ${member.capturedAt}`);
    }
    console.log(
      `[backup] ${manifest.mode} archive written to ${destination} (mode 0600). It contains every ` +
        `secret this cell holds: treat it as one.`,
    );
  } catch (err) {
    console.error(`[backup] refusing: ${err.message}`);
    process.exit(1);
  }
}
