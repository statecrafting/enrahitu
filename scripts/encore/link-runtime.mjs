#!/usr/bin/env node
/**
 * Expose the built napi runtime under the name Node can require().
 * cargo emits libencore_js_runtime.{dylib,so}; the encore.dev JS runtime
 * loads ENCORE_RUNTIME_LIB via require(), which needs a .node extension.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const releaseDir = join(repoRoot, "vendor/encore/target/release");

// CMake (libz-ng-sys) writes dependency-tracking files with a .ts extension
// into the cargo target trees; the tsparser app walk only skips node_modules/
// encore.gen/__tests__, so stray "TypeScript" there breaks `parse`. Prune.
for (const t of ["target", "target-linux"]) {
  const dir = join(repoRoot, "vendor/encore", t);
  if (existsSync(dir)) spawnSync("find", [dir, "-name", "*.ts", "-type", "f", "-delete"]);
}

const candidates = ["libencore_js_runtime.dylib", "libencore_js_runtime.so"];
const src = candidates.map((c) => join(releaseDir, c)).find(existsSync);
if (!src) {
  console.error(`no runtime dylib found in ${releaseDir}; run: npm run build:runtime`);
  process.exit(1);
}
const dst = join(releaseDir, "encore-runtime.node");
copyFileSync(src, dst);
console.log(`[link-runtime] ${dst}`);
