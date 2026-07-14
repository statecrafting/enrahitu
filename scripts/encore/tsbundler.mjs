#!/usr/bin/env node
/**
 * Drop-in replacement for Encore's `tsbundler-encore` (a Go wrapper around
 * esbuild), invoked by the vendored tsparser during `compile` via the
 * ENCORE_TSBUNDLER_PATH env var. Options mirror
 * cli/cmd/tsbundler-encore/main.go @ v1.57.9 exactly; the only difference is
 * that this shim uses the npm esbuild package instead of the Go esbuild API.
 *
 * Invocation (from tsparser's EsbuildCompiler):
 *   tsbundler --bundle --engine=node:21 --outdir=<dir> <entrypoints...>
 */
import { build } from "esbuild";
import { dirname } from "node:path";

const entryPoints = [];
let outdir = "dist";
let minify = false;
const engines = [];

for (const arg of process.argv.slice(2)) {
  if (arg === "--bundle") continue; // bundling is always on, as upstream
  else if (arg === "--minify") minify = true;
  else if (arg.startsWith("--engine=")) engines.push(arg.slice("--engine=".length));
  else if (arg.startsWith("--outdir=")) outdir = arg.slice("--outdir=".length);
  else if (arg.startsWith("-v") || arg === "--verbose") continue;
  else if (arg.startsWith("--")) {
    console.error(`tsbundler shim: unknown flag ${arg}`);
    process.exit(1);
  } else entryPoints.push(arg);
}

if (entryPoints.length === 0) {
  console.error("tsbundler shim: no entrypoints given");
  process.exit(1);
}

// Upstream: single entrypoint uses its grandparent dir as outbase so the
// "[dir]" token is preserved in output paths.
const outbase = entryPoints.length === 1 ? dirname(dirname(entryPoints[0])) : undefined;

// Upstream default engine is node:21; map "node:21" -> esbuild "node21".
const target = ["es2022", ...engines.map((e) => e.replace(":", ""))];

const banner = `// This file was bundled by the enrahitu vendored Encore toolchain (v1.57.9)
//
// https://encore.dev`;

try {
  const result = await build({
    logLevel: "warning",
    banner: { js: banner },
    charset: "utf8",
    sourcemap: "linked",
    packages: "external",
    treeShaking: true,
    platform: "node",
    format: "esm",
    target,
    minifyWhitespace: minify,
    minifySyntax: minify,
    minifyIdentifiers: minify,
    entryNames: "[dir]/[name]",
    entryPoints,
    bundle: true,
    outdir,
    outbase,
    write: true,
    outExtension: { ".js": ".mjs" },
    define: { ENCORE_DROP_TESTS: "true" },
  });
  if (result.errors.length > 0) process.exit(1);
} catch {
  // esbuild already printed diagnostics to stderr.
  process.exit(1);
}
