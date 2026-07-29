#!/usr/bin/env node
/**
 * The chassis lock and the upgrade preflight (spec 035 §3.2, §3.4).
 *
 * enrahitu ships as a working application that an organization extends rather
 * than forks (spec 001 §4.1). That sentence is a claim about upgrades, and a
 * claim about upgrades is worth nothing unless something can check it. The
 * check needs one fact an upgrade cannot otherwise recover: **which chassis
 * files this deployment has edited.**
 *
 *   node scripts/chassis-lock.mjs             # write chassis.lock
 *   node scripts/chassis-lock.mjs --check     # fail if the lock drifted (CI gate)
 *   node scripts/chassis-lock.mjs --preflight # classify every chassis file
 *
 * `--check` runs in CI on the chassis's own repo, where every change to a
 * chassis file is legitimate and the lock simply has to keep up.
 *
 * `--preflight` is what a stamped deployment runs BEFORE taking an upgrade. It
 * compares the working tree against the lock the chassis shipped and sorts
 * every file into one of three outcomes:
 *
 *   unmodified  the upgrade replaces it silently; nothing is lost
 *   modified    the upgrade would discard a local edit; reported, never silent
 *   removed     a chassis file was deleted locally; same treatment
 *
 * Nothing outside the lock is examined at all, which is the other half of the
 * contract: `app/` is the organization's and an upgrade has no opinion about it.
 *
 * ## Why a lock file rather than a diff against upstream
 *
 * A diff needs the upstream tree, which means a git remote, a fetch, and a
 * shared history. A stamped app may have none of those: spec 012's provenance
 * records where it came from, not a live link back. A hash list travels inside
 * the artifact and answers the question offline, which is the same reason
 * `package-lock.json` exists rather than resolving the registry every time.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = join(repoRoot, "chassis.lock");

/**
 * The chassis: every path an upgrade owns and may replace wholesale.
 *
 * Stated as an explicit roster rather than "everything except app/", and the
 * difference matters. An exclusion list makes a newly added top-level directory
 * chassis-owned by default, so the first person to add one silently takes it
 * away from the organization. An inclusion list makes the same mistake a
 * missing entry that `--check` reports.
 */
const CHASSIS_ROOTS = [
  "backend",
  "frontend",
  "frontend-admin",
  "docker",
  "scripts",
  "contracts",
  "specs",
  "standards",
  "testing",
  "e2e",
];

const CHASSIS_FILES = [
  "app-manifest.chassis.json",
  "app-model.json",
  "encore.app",
  "package.json",
  "package-lock.json",
  "template.toml",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.setup.ts",
  "spec-spine.toml",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "LICENSE",
];

/**
 * Skipped inside a chassis root: build output, dependencies, and generated
 * trees. They are reproducible from what is locked, so hashing them would make
 * the lock churn on every build without telling anyone anything.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-admin",
  ".encore",
  "test-results",
  "playwright-report",
]);

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".derived") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function chassisPaths() {
  const files = [];
  for (const root of CHASSIS_ROOTS) {
    const full = join(repoRoot, root);
    if (existsSync(full) && statSync(full).isDirectory()) walk(full, files);
  }
  for (const file of CHASSIS_FILES) {
    const full = join(repoRoot, file);
    if (existsSync(full)) files.push(full);
  }
  // POSIX separators so a lock written on one platform verifies on another.
  return files.map((f) => relative(repoRoot, f).split(sep).join("/")).sort();
}

function hash(relPath) {
  return createHash("sha256").update(readFileSync(join(repoRoot, relPath))).digest("hex");
}

function build() {
  const files = {};
  for (const path of chassisPaths()) files[path] = hash(path);
  return { version: 1, files };
}

function serialize(lock) {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

function readLock() {
  if (!existsSync(LOCK)) {
    console.error("[chassis-lock] chassis.lock is missing; run `npm run chassis:lock`");
    process.exit(1);
  }
  return JSON.parse(readFileSync(LOCK, "utf8"));
}

/**
 * Classify every locked file against the working tree.
 *
 * `added` is reported but is not an upgrade hazard: a new file inside a chassis
 * root is the organization's until the chassis ships one at the same path, and
 * that collision surfaces as a `modified` on the next lock.
 */
export function classify(lock, current) {
  const modified = [];
  const removed = [];
  let unmodified = 0;
  for (const [path, expected] of Object.entries(lock.files)) {
    const actual = current.files[path];
    if (actual === undefined) removed.push(path);
    else if (actual !== expected) modified.push(path);
    else unmodified++;
  }
  const added = Object.keys(current.files).filter((p) => !(p in lock.files));
  return { unmodified, modified, removed, added };
}

function preflight() {
  const lock = readLock();
  const { unmodified, modified, removed, added } = classify(lock, build());

  console.log(`[chassis-lock] ${unmodified} chassis file(s) unmodified: an upgrade replaces these silently.`);
  if (added.length > 0) {
    console.log(`[chassis-lock] ${added.length} file(s) added inside a chassis root (yours until the chassis ships one at the same path):`);
    for (const p of added) console.log(`    + ${p}`);
  }
  if (modified.length === 0 && removed.length === 0) {
    console.log("[chassis-lock] no local edits to chassis files. This upgrade is safe to take as-is.");
    return 0;
  }
  console.log("");
  console.log("[chassis-lock] An upgrade would DISCARD the following local changes:");
  for (const p of modified) console.log(`    M ${p}`);
  for (const p of removed) console.log(`    D ${p}`);
  console.log("");
  console.log("[chassis-lock] Each one is a fork of the chassis at that path. For every file above, either");
  console.log("    - move the change into app/, where an upgrade never reaches, or");
  console.log("    - propose it upstream, so the chassis carries it and every deployment gets it, or");
  console.log("    - accept losing it, and re-apply after the upgrade.");
  console.log("[chassis-lock] Nothing under app/ was examined; that directory is yours.");
  return 1;
}

function main(argv) {
  if (argv.includes("--preflight")) process.exit(preflight());

  const current = build();
  if (argv.includes("--check")) {
    const lock = readLock();
    if (serialize(lock) !== serialize(current)) {
      const { modified, removed, added } = classify(lock, current);
      console.error("[chassis-lock] chassis.lock has drifted from the tree.");
      for (const p of modified) console.error(`    M ${p}`);
      for (const p of removed) console.error(`    D ${p}`);
      for (const p of added) console.error(`    A ${p}`);
      console.error("[chassis-lock] Run `npm run chassis:lock` and commit the result.");
      process.exit(1);
    }
    console.log(`[chassis-lock] lock is fresh (${Object.keys(current.files).length} files)`);
    return;
  }

  writeFileSync(LOCK, serialize(current));
  console.log(`[chassis-lock] wrote chassis.lock (${Object.keys(current.files).length} files)`);
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2));
}
