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
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * The roster comes from `git ls-files`, not from a filesystem walk.
 *
 * The chassis is what the chassis SHIPS, and git already knows exactly that.
 * A walk knows only what happens to be on the disk of whoever ran it, so a
 * stale Playwright report or a local scratch file lands in the lock, and then
 * CI on a clean checkout reports it as a deleted chassis file. That is not a
 * hypothetical: it is how this function came to be written this way, on the
 * first CI run of the gate that introduced it.
 *
 * The rule the walk was trying to express (skip build output, dependencies and
 * generated trees, because they are reproducible from what is locked) is
 * exactly what `.gitignore` already says, in one place, maintained by everyone.
 * Restating it in a `SKIP_DIRS` set was a second copy of a list that was
 * already wrong the moment the two disagreed.
 */
function gitTrackedFiles() {
  try {
    return execFileSync("git", ["ls-files", "-z", "--cached", "--"], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString()
      .split("\0")
      .filter(Boolean);
  } catch (err) {
    console.error(
      "[chassis-lock] cannot list tracked files. This needs to run inside a git " +
        "checkout: the chassis roster is what git tracks, because that is what the " +
        `chassis ships. (${String(err).split("\n")[0]})`,
    );
    process.exit(1);
  }
}

function isChassisPath(relPath) {
  if (CHASSIS_FILES.includes(relPath)) return true;
  return CHASSIS_ROOTS.some((root) => relPath.startsWith(`${root}/`));
}

function chassisPaths() {
  // git already emits POSIX separators, so a lock written on one platform
  // verifies on another without normalization.
  return gitTrackedFiles().filter(isChassisPath).sort();
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
