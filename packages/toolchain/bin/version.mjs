#!/usr/bin/env node
/**
 * `enrahitu-toolchain --version`: report the toolchain package's own semver
 * and the pinned upstream Encore version it wraps (spec 018 §3 versioning).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const UPSTREAM_ENCORE = "v1.57.9";
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

console.log(`@enrahitu/toolchain ${version} (encore ${UPSTREAM_ENCORE})`);
