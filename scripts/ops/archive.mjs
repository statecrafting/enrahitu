/**
 * What `backup` writes and `restore` reads (spec 027 §3.1-§3.3).
 *
 * The two verbs share this file rather than a convention, because the archive
 * is the contract between them and a convention is what drifts. Everything
 * about the artifact that both must agree on lives here: the member layout, the
 * manifest shape, the checksum, and the two refusals that make the artifact
 * safe to produce and safe to consume.
 *
 * ## The archive is a secret in its entirety
 *
 * §3.1's key-binding argument is now true twice over. rauthy encrypts data at
 * rest with `ENC_KEYS`, and the app's hiqlite encrypts its snapshots with
 * `ENRAHITU_HIQ_ENC_KEYS`; both live in `secrets.env`, and either store restored
 * without its matching keys is undecryptable. So keys and the two encrypted
 * stores travel together or the archive is worthless, which is why this is one
 * artifact rather than parts an operator assembles. It carries every secret the
 * cell holds: mode 0600, and a destination anyone else can read is refused
 * rather than warned about.
 *
 * ## Why `tar` and not a library
 *
 * The verbs run in the packaged image with production dependencies only, and
 * adding a tar dependency to ship a backup would put a runtime package in every
 * deployment for a code path most of them run monthly. `tar` is essential-priority
 * in the Debian base the image is built on, so it is present wherever the verbs
 * are.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The layout inside the archive. One directory per state class (§3.1). */
export const MEMBERS = {
  ledger: "ledger",
  state: "state",
  rauthy: "rauthy",
  keys: "keys",
};

/** Manifest filename, at the archive root. */
export const MANIFEST = "manifest.json";

/**
 * The default data directory, matching the entrypoint's.
 *
 * Kept beside the layout it describes rather than imported from the pre-flight
 * verb: that verb models the boot it precedes, and this one models the volume
 * it copies. The two agree today and are allowed to diverge.
 */
export const DEFAULT_DATA_DIR = "/data";

/** SHA-256 of a file, streamed so a multi-gigabyte member does not buffer. */
export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
  });
}

/**
 * Refuse a destination other users can read.
 *
 * Checked on the directory rather than the file, because the file does not
 * exist yet and its mode is this verb's to set. A world-readable directory is
 * refused even though the archive itself is written 0600: the failure mode is
 * an operator writing to /tmp on a shared box, where the mode of the file is
 * not the whole of who can reach it.
 */
export function assertPrivateDirectory(dir) {
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    throw new Error(`${dir} does not exist`);
  }
  if (!stats.isDirectory()) throw new Error(`${dir} is not a directory`);
  const mode = stats.mode & 0o777;
  if (mode & 0o007) {
    throw new Error(
      `${dir} is mode ${mode.toString(8)}, which other users can reach. This archive contains ` +
        `every secret the cell holds: the signing keys, rauthy's encryption keys, and the ` +
        `admin password. Write it somewhere only its owner can read (chmod 700).`,
    );
  }
}

/**
 * Is a cell running against this volume?
 *
 * Asked of the app's listening port rather than of the volume, and the reason
 * is worth stating because the volume looks like it should answer. hiqlite's
 * `state_machine/lock` is NEVER removed: the addon exposes no `shutdown()`, so
 * the lock survives a clean stop and is present on every stopped cell (spec 002,
 * amendment 2026-07-30). A verb that read it as a liveness signal would refuse
 * every cold backup it was asked for, which is the mode §3.2 calls the honest
 * default.
 *
 * The port is derived exactly as the pre-flight verb derives it, by importing
 * that derivation rather than repeating it: the Encore runtime takes
 * `ENCORE_LISTEN_ADDR`, then `PORT`, then 8080, so the packaged image binds 8080
 * and the dev topology binds 4000. A verb checking the constant would report on
 * a port nothing was using.
 */
export async function cellIsRunning(env = process.env) {
  const { plannedPorts, probePort } = await import("./preflight.mjs");
  const app = plannedPorts(env).find((entry) => entry.label === "app");
  // `probePort` answers "could this process bind it". Something already
  // listening is the cell, so a port that cannot be bound is a running cell.
  const free = await probePort(app.host === "0.0.0.0" ? "127.0.0.1" : app.host, app.port);
  return { running: !free, host: app.host, port: app.port };
}

/** Create the archive from a staging directory, 0600, deterministic member order. */
export function writeArchive(stageDir, destination) {
  execFileSync("tar", ["-czf", destination, "-C", stageDir, "."], { stdio: "pipe" });
  execFileSync("chmod", ["600", destination]);
}

/** Extract an archive into a directory. */
export function extractArchive(archive, into) {
  execFileSync("tar", ["-xzf", archive, "-C", into], { stdio: "pipe" });
}

/** List an archive's members without extracting it. */
export function listArchive(archive) {
  return execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.replace(/^\.\//, "").trim())
    .filter(Boolean);
}

export async function writeManifest(stageDir, manifest) {
  await writeFile(join(stageDir, MANIFEST), JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
  });
}

export async function readManifest(dir) {
  return JSON.parse(await readFile(join(dir, MANIFEST), "utf8"));
}

/**
 * The model and gate-config hashes, read out of the chain rather than off disk.
 *
 * The kernel writes a genesis Decision into `kernel_decisions` carrying both
 * (spec 021, `backend/kernel/decisions.ts`), so the archive's hashes describe
 * the data in the archive rather than the image that happened to run the verb.
 * That distinction is the whole value of recording them: §3.3's restore warning
 * compares the archive's model hash against the image's, and a hash copied from
 * the running image would make that comparison always agree with itself.
 *
 * A ledger with no chain yet answers `null` rather than failing. Backing up a
 * cell that has never adjudicated anything is legitimate.
 */
export async function chainHashes(client) {
  try {
    const rows = await client.execute(
      `SELECT payload FROM kernel_decisions WHERE record_id LIKE 'genesis-%' ORDER BY seq DESC LIMIT 1`,
    );
    const row = rows.rows?.[0] ?? rows[0];
    if (!row) return { modelHash: null, gateConfigHash: null };
    const payload = JSON.parse(String(row.payload));
    return {
      modelHash: payload.modelHash ?? null,
      gateConfigHash: payload.gateConfigHash ?? null,
    };
  } catch {
    // No table, no chain, or an unreadable payload. The archive is still valid;
    // it simply cannot say what model produced it.
    return { modelHash: null, gateConfigHash: null };
  }
}

/** Scheme to driver, matching the pre-flight verb's closed table. */
export function ledgerScheme(raw) {
  try {
    return new URL(raw).protocol.replace(/:$/, "");
  } catch {
    return null;
  }
}

/**
 * Is the ledger's authoritative copy on this volume?
 *
 * Only a `file:` ledger is. A Turso replica syncs from a remote primary and a
 * Postgres ledger is remote by definition, so §3.1 has the verb detect the
 * scheme, say so, and back up only what it owns rather than pretending to have
 * captured a database it cannot reach.
 */
export function ledgerIsLocal(raw) {
  return ledgerScheme(raw) === "file";
}
