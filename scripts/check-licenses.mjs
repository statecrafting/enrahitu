#!/usr/bin/env node
/**
 * The AGPL boundary guard (spec 001 §4.7).
 *
 * This repository is Apache-2.0 and must stay permissive, because stamped apps
 * copy template code (spec 009 §3.1). Customer-reaching packages therefore
 * never depend on AGPL-licensed ones: admission and audit route through
 * `@statecrafting/kernel-native` (Apache-2.0), never
 * `@statecrafting/governance-native` (AGPL-3.0), whose own README states it
 * must never be depended on by the toolchain, hiqlite-native, or kernel-native.
 *
 * The two package names differ by one word and sit in the same scope, so this
 * is machine-checked rather than remembered. It runs HERE, in the repo whose
 * `package.json` is where such a dependency would actually be declared; a guard
 * that lives only upstream does not gate this repo's PRs.
 *
 * Three independent checks, because each catches a different mistake:
 *
 *   1. Declared dependencies in package.json      catches the edit, pre-install
 *   2. The committed lockfile's recorded licenses catches the transitive pull
 *   3. Installed node_modules license fields      catches a lockfile that lies
 *
 * Check 3 is skipped when node_modules is absent (a fresh clone, or CI before
 * `npm ci`); checks 1 and 2 always run, so the guard is never silently a no-op.
 *
 *   node scripts/check-licenses.mjs [--repo <dir>] [--json]
 *
 * Exit 0 clean, exit 1 on any violation. `--repo` exists so the guard can be
 * pointed at a fixture tree and proven to fail; a guard whose failure path is
 * never exercised is a guard nobody knows is broken.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

const repoFlag = process.argv.indexOf("--repo");
const repoRoot =
  repoFlag !== -1 && process.argv[repoFlag + 1]
    ? resolve(process.argv[repoFlag + 1])
    : join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Copyleft families that may never reach a customer through this repo.
 * MPL-2.0 is deliberately absent: it is file-level copyleft and the Encore
 * core is consumed under it by design (spec 008).
 */
const FORBIDDEN_LICENSE = /\bAGPL\b|\bGPL-[23]/i;

/**
 * Names that are forbidden regardless of what any manifest claims, because the
 * whole point of the guard is the one-word-apart confusion. A mislabelled or
 * absent license field must not buy a pass.
 */
const FORBIDDEN_NAMES = new Set(["@statecrafting/governance-native"]);

/** Package names whose license field is a known false positive, with a reason. */
const ALLOWED_EXCEPTIONS = new Map();

const violations = [];

function flag(source, name, license, detail) {
  violations.push({ source, name, license: license ?? "(none declared)", detail });
}

// ---------------------------------------------------------------------------
// 1. Declared dependencies
// ---------------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
for (const field of DEP_FIELDS) {
  for (const name of Object.keys(pkg[field] ?? {})) {
    if (FORBIDDEN_NAMES.has(name)) {
      flag("package.json", name, null, `declared in ${field}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. The committed lockfile
// ---------------------------------------------------------------------------
const lockPath = join(repoRoot, "package-lock.json");
if (!existsSync(lockPath)) {
  console.error("[check-licenses] package-lock.json is missing; the guard cannot run");
  process.exit(1);
}
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
if (lock.lockfileVersion < 3) {
  console.error(
    `[check-licenses] lockfileVersion ${lock.lockfileVersion} does not record per-package licenses; need >= 3`,
  );
  process.exit(1);
}

/** "node_modules/a/node_modules/@scope/b" -> "@scope/b" */
function nameFromLockKey(key, entry) {
  if (entry?.name) return entry.name;
  const idx = key.lastIndexOf("node_modules/");
  return idx === -1 ? key : key.slice(idx + "node_modules/".length);
}

let lockChecked = 0;
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  if (key === "") continue; // the root package itself
  const name = nameFromLockKey(key, entry);
  if (ALLOWED_EXCEPTIONS.has(name)) continue;
  lockChecked += 1;
  if (FORBIDDEN_NAMES.has(name)) {
    flag("package-lock.json", name, entry.license, `resolved at ${key}`);
    continue;
  }
  if (typeof entry.license === "string" && FORBIDDEN_LICENSE.test(entry.license)) {
    flag("package-lock.json", name, entry.license, `resolved at ${key}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Installed tree (skipped when absent)
// ---------------------------------------------------------------------------
const nodeModules = join(repoRoot, "node_modules");
let installedChecked = 0;

function checkInstalled(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of entries) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
    if (dirent.name === ".bin" || dirent.name === ".package-lock.json") continue;
    const full = join(dir, dirent.name);
    if (dirent.name.startsWith("@")) {
      checkInstalled(full); // scope directory, one level deeper
      continue;
    }
    const manifestPath = join(full, "package.json");
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const name = manifest.name ?? dirent.name;
    installedChecked += 1;
    if (!ALLOWED_EXCEPTIONS.has(name)) {
      const license =
        typeof manifest.license === "string" ? manifest.license : manifest.license?.type;
      if (FORBIDDEN_NAMES.has(name)) {
        flag("node_modules", name, license, full.slice(repoRoot.length + 1));
      } else if (typeof license === "string" && FORBIDDEN_LICENSE.test(license)) {
        flag("node_modules", name, license, full.slice(repoRoot.length + 1));
      }
    }
    const nested = join(full, "node_modules");
    if (existsSync(nested)) checkInstalled(nested);
  }
}

if (existsSync(nodeModules)) checkInstalled(nodeModules);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const asJson = process.argv.includes("--json");
const summary = {
  ok: violations.length === 0,
  lockPackagesChecked: lockChecked,
  installedPackagesChecked: installedChecked,
  installedTreeScanned: existsSync(nodeModules),
  violations,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else if (summary.ok) {
  const installed = summary.installedTreeScanned
    ? `${installedChecked} installed`
    : "installed tree absent (skipped)";
  console.log(`[check-licenses] clean: ${lockChecked} locked, ${installed}`);
} else {
  console.error("[check-licenses] AGPL boundary violated (spec 001 §4.7):\n");
  for (const v of violations) {
    console.error(`  ${v.name}  [${v.license}]`);
    console.error(`    found by: ${v.source} (${v.detail})`);
  }
  console.error(
    "\nCustomer-reaching packages must not depend on AGPL code. Admission and",
  );
  console.error(
    "audit route through @statecrafting/kernel-native (Apache-2.0), never",
  );
  console.error("@statecrafting/governance-native (AGPL-3.0).");
}

// Guard against a symlinked checkout: comparing import.meta.url to argv[1]
// directly no-ops silently when the path is a symlink.
const invokedDirectly =
  import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
if (invokedDirectly) process.exit(summary.ok ? 0 : 1);

export { summary };
