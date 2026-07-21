#!/usr/bin/env node
/**
 * enrahitu-extract: the TS-tier app-model producer (spec 021 §3.2-§3.3,
 * implementing spec 020 §3.6). Reads .encore/build/meta (run
 * enrahitu-build first) plus app-manifest.json, lowers, seals, verifies,
 * and emits app-model.json at the repo root. With --check, recomputes and
 * compares against the committed model instead of writing.
 *
 * Exit codes (spec-spine discipline): 0 ok; 1 verify violation (ceiling,
 * ban-list, schema, dangling ref, oracle disagreement); 2 stale committed
 * model (including hand-edits); 3 I/O or input error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

import {
  canonicalStringify,
  computeIntegrityHash,
  prettyStringify,
} from "../lib/extract/canonical.mjs";
import { decodeMeta } from "../lib/extract/meta.mjs";
import { lowerModel } from "../lib/extract/lower.mjs";
import { verifyModel, VerifyError } from "../lib/extract/verify.mjs";

const require = createRequire(import.meta.url);
const kernel = require("@statecrafting/kernel-native");

const repoRoot = process.cwd();
const checkMode = process.argv.includes("--check");
const modelPath = join(repoRoot, "app-model.json");

function fail(code, message) {
  console.error(`enrahitu-extract: ${message}`);
  process.exit(code);
}

function gitSource() {
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })
      .toString()
      .trim();
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot })
      .toString()
      .trim();
    return { revision, uncommittedChanges: status.length > 0 };
  } catch (err) {
    fail(3, `cannot determine git identity: ${err.message}`);
  }
}

async function recompute() {
  const metaPath = join(repoRoot, ".encore", "build", "meta");
  if (!existsSync(metaPath)) {
    fail(3, `${metaPath} not found: run the app build (enrahitu-build) first`);
  }
  const manifestPath = join(repoRoot, "app-manifest.json");
  if (!existsSync(manifestPath)) {
    fail(3, `${manifestPath} not found: the capability manifest is required (spec 021)`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    fail(3, `app-manifest.json does not parse: ${err.message}`);
  }
  const meta = await decodeMeta(metaPath);
  const producerVersion = require("../package.json").version;

  const model = lowerModel({ meta, manifest, source: gitSource(), producerVersion });

  // Seal: pin the gate roster hash and the integrity hash, then verify the
  // sealed document, then close the cross-language loop with the kernel.
  model.gate.configHash = kernel.gateConfigHash(JSON.stringify(model.gate.checks));
  model.integrity.hash = computeIntegrityHash(model);

  try {
    verifyModel({ model, manifest, meta, repoRoot });
  } catch (err) {
    if (err instanceof VerifyError) fail(1, err.message);
    throw err;
  }

  let genesis;
  try {
    genesis = JSON.parse(kernel.genesisPayload(JSON.stringify(model)));
  } catch (err) {
    fail(1, `the kernel refuses the sealed model: ${err.message}`);
  }
  if (genesis.modelHash !== model.integrity.hash) {
    fail(
      1,
      `hash oracle disagreement: toolchain computed ${model.integrity.hash}, kernel computed ${genesis.modelHash}`,
    );
  }
  return model;
}

/** Semantic comparison form: everything except source and integrity. */
function comparable(model) {
  const { source: _s, integrity: _i, ...rest } = model;
  return canonicalStringify(rest);
}

const model = await recompute();

if (!checkMode) {
  writeFileSync(modelPath, prettyStringify(model));
  console.log(
    `enrahitu-extract: wrote app-model.json (${model.integrity.hash}, gate ${model.gate.configHash})`,
  );
  process.exit(0);
}

if (!existsSync(modelPath)) {
  fail(2, "no committed app-model.json: run `npm run extract:model` and commit the result");
}
let committed;
try {
  committed = JSON.parse(readFileSync(modelPath, "utf8"));
} catch (err) {
  fail(2, `committed app-model.json does not parse: ${err.message}`);
}
if (computeIntegrityHash(committed) !== committed.integrity?.hash) {
  fail(2, "committed app-model.json is not self-consistent (hand-edited?): its integrity.hash does not match its content");
}
if (comparable(committed) !== comparable(model)) {
  fail(2, "committed app-model.json is stale: recomputation differs; run `npm run extract:model` and commit the result");
}
console.log(`enrahitu-extract: committed model is fresh (${committed.integrity.hash})`);
