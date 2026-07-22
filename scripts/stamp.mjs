#!/usr/bin/env node
// Scaffold verb for the enrahitu template (spec 014). Turns a fresh clone of
// this chassis into a named app: slot validation, app-name substitution in the
// manifest AND the lockfile, provenance-cert placement, derived-truth
// regeneration, and a README lineage marker. This is the recipe spec 009 §3.2
// reserved as the `scaffold` verb; template.toml exposes it at contract 0.4.0.
//
//   node scripts/stamp.mjs --app-name <name> --org <org> [--frontend vue] \
//     [--cert <path-to-born-with.json>] [--stamped-from <template-commit-sha>]
//
// Run from the repo root of a fresh clone. Exit 0 on success; non-zero with the
// failing step named on any failure. Idempotent: re-running with the same slots
// is a no-op that exits 0. Dependency-free (node builtins only), matching
// verify-born-with.mjs, so a stamped app can run it with nothing but node.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// A failure carries the name of the step that produced it, so the CLI can print
// "stamp failed at step X" rather than a bare stack trace.
export class StampError extends Error {
  constructor(step, message) {
    super(message);
    this.step = step;
  }
}

// --- Slot rules, read from the contract (template.toml [slots]) -------------
// template.toml is the single source of truth for slot shape (spec 014 §3.1),
// so the pattern and allowed list are read from it rather than hardcoded here.
// A purpose-built extractor for the known inline-table shape keeps this
// dependency-free; a reformatted contract that this cannot parse fails loudly.
function extractTable(tomlText, tableName) {
  const lines = tomlText.split(/\r?\n/);
  const header = `[${tableName}]`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === header) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  const body = [];
  for (let i = start; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break; // next table header ends this one
    body.push(lines[i]);
  }
  return body.join("\n");
}

function slotLine(tableBody, key) {
  return tableBody.split(/\r?\n/).find((l) => new RegExp(`^\\s*${key}\\s*=`).test(l)) ?? null;
}

export function readSlots(templateTomlPath) {
  let toml;
  try {
    toml = readFileSync(templateTomlPath, "utf8");
  } catch (err) {
    throw new StampError("validate slots", `cannot read ${templateTomlPath}: ${err.message}`);
  }
  const slots = extractTable(toml, "slots");
  if (slots === null) throw new StampError("validate slots", `no [slots] table in ${templateTomlPath}`);

  const appNameLine = slotLine(slots, "app_name");
  const pattern = appNameLine?.match(/pattern\s*=\s*"([^"]*)"/)?.[1] ?? null;

  const orgLine = slotLine(slots, "org");
  const orgRequired = !!(orgLine && /required\s*=\s*true/.test(orgLine));

  const frontendLine = slotLine(slots, "frontend");
  const allowedRaw = frontendLine?.match(/allowed\s*=\s*\[([^\]]*)\]/)?.[1] ?? "";
  const frontendAllowed = allowedRaw
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  const frontendDefault = frontendLine?.match(/default\s*=\s*"([^"]*)"/)?.[1] ?? null;

  return { appNamePattern: pattern, orgRequired, frontendAllowed, frontendDefault };
}

export function validateSlots(slots, values) {
  const problems = [];
  if (!values.appName) {
    problems.push("--app-name is required");
  } else if (slots.appNamePattern && !new RegExp(slots.appNamePattern).test(values.appName)) {
    problems.push(`--app-name "${values.appName}" must match /${slots.appNamePattern}/`);
  }
  if (slots.orgRequired && !values.org) problems.push("--org is required");

  const frontend = values.frontend ?? slots.frontendDefault;
  if (slots.frontendAllowed.length > 0 && !slots.frontendAllowed.includes(frontend)) {
    problems.push(`--frontend "${frontend}" is not in the allowed list [${slots.frontendAllowed.join(", ")}]`);
  }
  if (problems.length > 0) throw new StampError("validate slots", problems.join("; "));
  return { ...values, frontend };
}

// --- Steps ------------------------------------------------------------------
// Each frontend flavor (template.toml [slots].frontend.allowed) is a sibling
// source directory (spec 015). This map is stamp.mjs's half of that contract:
// the allowed list lives in template.toml (spec 009), the directory each value
// resolves to lives here. The two are amended together (spec 015 §2). A flavor
// in the allowed list with no entry here fails the stamp loudly rather than
// silently pruning nothing.
const FLAVOR_DIRS = { vue: "frontend", "react-rr7": "frontend-react" };

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// Substitute the app name in package.json (root "name") and package-lock.json
// (root "name" and the packages[""] entry). Substrate names (@statecrafting/*,
// the hiqlite addon) are the chassis, not the app, and are deliberately left intact.
// v0 stamping edits no dependencies, so there is no npm install: were that to
// change, the refresh must be `npm install --package-lock-only` from the
// committed lock, never a full install (which prunes linux platform optionals
// on macOS and breaks `npm ci` on CI runners). Spec 014 §3.2/§3.3.
function substituteAppName(root, appName) {
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.name = appName;
  writeJson(pkgPath, pkg);

  const lockPath = join(root, "package-lock.json");
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.name = appName;
    if (lock.packages && lock.packages[""]) lock.packages[""].name = appName;
    writeJson(lockPath, lock);
  }
}

// Keep the selected frontend flavor, prune the rest, and repoint the root
// build:web / dev:web scripts at the survivor's directory. A flavor is a slot,
// not a fork (spec 009 §3.1): the chassis carries every flavor directory, a
// stamped app carries exactly one. Idempotent: a re-run finds the unselected
// dirs already gone and the scripts already pointed at the survivor. Only script
// keys that exist are rewritten, so a minimal tree without them is left intact.
// Spec 014 (scaffold) x spec 015 (flavors).
function selectFrontendFlavor(root, frontend) {
  const chosenDir = FLAVOR_DIRS[frontend];
  if (!chosenDir) {
    throw new StampError("select frontend flavor", `no directory mapping for frontend flavor "${frontend}"`);
  }

  const pruned = [];
  for (const [flavor, dir] of Object.entries(FLAVOR_DIRS)) {
    if (flavor === frontend) continue;
    const abs = join(root, dir);
    if (existsSync(abs)) {
      rmSync(abs, { recursive: true, force: true });
      pruned.push(dir);
    }
  }

  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  let rewrote = false;
  if (pkg.scripts) {
    if (typeof pkg.scripts["build:web"] === "string") {
      pkg.scripts["build:web"] = `npm --prefix ${chosenDir} run build`;
      rewrote = true;
    }
    if (typeof pkg.scripts["dev:web"] === "string") {
      pkg.scripts["dev:web"] = `npm --prefix ${chosenDir} run dev`;
      rewrote = true;
    }
  }
  if (rewrote) writeJson(pkgPath, pkg);
  return { chosenDir, pruned, rewrote };
}

// Place the born-with cert and validate it through the template-owned validator
// (spec 012). A failing cert fails the stamp; the placed copy is rolled back so
// a failed stamp never leaves a known-bad cert on disk. Spec 014 §3.4.
function placeCert(root, certArg) {
  const src = resolve(process.cwd(), certArg);
  if (!existsSync(src)) throw new StampError("provenance", `--cert not found: ${src}`);
  const dest = join(root, ".statecraft", "born-with.json");
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);

  const validator = join(root, "scripts", "verify-born-with.mjs");
  const res = spawnSync(process.execPath, [validator, dest], { encoding: "utf8" });
  if (res.status !== 0) {
    rmSync(dest, { force: true });
    throw new StampError("provenance", `cert failed validation:\n${(res.stderr || res.stdout || "").trim()}`);
  }
  return dest;
}

// Regenerate the derived truth (registry + codebase index). The app name is a
// hashed input, so stale shards would fail the stamped repo's own spine gate.
// Only a governed repo (one carrying spec-spine.toml) has derived truth to
// regenerate; a minimal tree without it is not governed and there is nothing to
// refresh. Where regeneration IS owed, an absent binary is a hard failure, never
// a silent skip. Spec 014 §3.5.
function regenerateDerived(root) {
  if (!existsSync(join(root, "spec-spine.toml"))) {
    return { ran: false, reason: "no spec-spine.toml at repo root (not a governed repo)" };
  }
  for (const sub of [["compile"], ["index"]]) {
    const res = spawnSync("spec-spine", sub, { cwd: root, encoding: "utf8" });
    if (res.error && res.error.code === "ENOENT") {
      throw new StampError(
        "regenerate derived truth",
        "spec-spine not found on PATH. Install it: cargo install spec-spine-cli",
      );
    }
    if (res.status !== 0) {
      throw new StampError(
        "regenerate derived truth",
        `spec-spine ${sub.join(" ")} failed:\n${(res.stderr || res.stdout || "").trim()}`,
      );
    }
  }
  return { ran: true };
}

function resolveTemplateCommit(root, stampedFrom) {
  if (stampedFrom) return stampedFrom;
  const res = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : "unknown";
}

// Append a "## Stamped" lineage marker to README.md. Idempotent: any existing
// trailing Stamped section is replaced, never duplicated, so a re-stamp leaves
// exactly one. Spec 014 §3.6.
function writeStampedSection(root, info) {
  const readmePath = join(root, "README.md");
  let text = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : `# ${info.appName}\n`;
  const marker = text.search(/\n## Stamped\b/);
  if (marker !== -1) text = text.slice(0, marker);
  text = `${text.replace(/\s*$/, "")}\n`;
  const section = [
    "",
    "## Stamped",
    "",
    `- app: \`${info.appName}\``,
    `- org: \`${info.org}\``,
    `- frontend: \`${info.frontend}\``,
    `- template: enrahitu @ \`${info.templateCommit}\``,
    `- stamped: ${info.date}`,
    "",
  ].join("\n");
  writeFileSync(readmePath, text + section);
}

// --- CLI --------------------------------------------------------------------
const USAGE = `Usage: node scripts/stamp.mjs --app-name <name> --org <org> \\
  [--frontend vue] [--cert <path-to-born-with.json>] [--stamped-from <template-commit-sha>]

Stamp a fresh clone of the enrahitu template into a named app (spec 014).`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new StampError("parse args", `${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--app-name": out.appName = next(); break;
      case "--org": out.org = next(); break;
      case "--frontend": out.frontend = next(); break;
      case "--cert": out.cert = next(); break;
      case "--stamped-from": out.stampedFrom = next(); break;
      case "-h":
      case "--help": out.help = true; break;
      default: throw new StampError("parse args", `unknown argument: ${a}`);
    }
  }
  return out;
}

export function main(argv, now = new Date()) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const slots = readSlots(join(repoRoot, "template.toml"));
  const values = validateSlots(slots, args);

  substituteAppName(repoRoot, values.appName);
  const flavor = selectFrontendFlavor(repoRoot, values.frontend);
  const certDest = args.cert ? placeCert(repoRoot, args.cert) : null;
  const derived = regenerateDerived(repoRoot);
  const templateCommit = resolveTemplateCommit(repoRoot, args.stampedFrom);
  const date = now.toISOString().slice(0, 10);
  writeStampedSection(repoRoot, {
    appName: values.appName,
    org: values.org,
    frontend: values.frontend,
    templateCommit,
    date,
  });

  console.log(`ok stamped ${values.appName} (org ${values.org}, frontend ${values.frontend})`);
  console.log(`  name -> ${values.appName} in package.json + package-lock.json`);
  console.log(
    `  frontend -> ${flavor.chosenDir}/${
      flavor.pruned.length ? ` (pruned ${flavor.pruned.join(", ")})` : ""
    }${flavor.rewrote ? "; build:web/dev:web repointed" : ""}`,
  );
  if (certDest) console.log(`  provenance cert -> ${certDest} (validated)`);
  console.log(
    derived.ran
      ? "  derived truth regenerated (spec-spine compile + index)"
      : `  derived truth: skipped (${derived.reason})`,
  );
  console.log(`  README lineage: enrahitu @ ${templateCommit} on ${date}`);
  return 0;
}

// Compare realpaths, not raw paths: node resolves symlinks for the main entry's
// import.meta.url (e.g. macOS /var -> /private/var) but not for process.argv[1],
// so a raw compare would silently no-op under a symlinked checkout.
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    if (err instanceof StampError) {
      console.error(`x stamp failed at step "${err.step}": ${err.message}`);
    } else {
      console.error(`x stamp failed: ${err.stack || err.message}`);
    }
    process.exit(1);
  }
}
