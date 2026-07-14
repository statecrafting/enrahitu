#!/usr/bin/env node
/**
 * Dev runner: the vendored-toolchain equivalent of `encore run --port=4000`.
 *
 * 1. builds the app (scripts/encore/build.mjs: parse -> meta, compile -> bundle)
 * 2. runs the bundle under plain node with the vendored napi runtime:
 *      ENCORE_RUNTIME_LIB        the cargo-built encore-runtime.node
 *      ENCORE_APP_META_PATH      .encore/build/meta (from parse)
 *      ENCORE_INFRA_CONFIG_PATH  infra.config.dev.json (no secrets section,
 *                                so secret() yields "" and the keys/ file
 *                                fallbacks apply, matching CLI dev behavior)
 *      PORT                      4000 (override: PORT=... npm run dev)
 *
 * .env is loaded for the app process (hiqlite addresses, driver flags),
 * matching how `encore run` picked it up.
 */
import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { augmentInfraConfig } from "./augment-infra.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeLib = join(repoRoot, "vendor/encore/target/release/encore-runtime.node");
const mainMjs = join(repoRoot, ".encore/build/combined/combined/main.mjs");
const port = process.env.PORT ?? "4000";

if (!existsSync(runtimeLib)) {
  console.error(`runtime lib not found at ${runtimeLib}; run: npm run build:runtime`);
  process.exit(1);
}

const build = spawnSync(process.execPath, [join(repoRoot, "scripts/encore/build.mjs")], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

// Augment the base infra config with the hosted services/gateways from the
// compile result (the runtime hosts nothing otherwise).
const infraPath = join(repoRoot, ".encore/build/infra.config.runtime.json");
augmentInfraConfig(
  join(repoRoot, "infra.config.dev.json"),
  join(repoRoot, ".encore/build/compile-result.json"),
  infraPath,
);

const nodeArgs = ["--enable-source-maps"];
if (existsSync(join(repoRoot, ".env"))) nodeArgs.push("--env-file=.env");
nodeArgs.push(mainMjs);

console.log(`[encore-dev] listening on http://localhost:${port}`);
const app = spawn(process.execPath, nodeArgs, {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    ENCORE_RUNTIME_LIB: runtimeLib,
    ENCORE_APP_META_PATH: join(repoRoot, ".encore/build/meta"),
    ENCORE_INFRA_CONFIG_PATH: infraPath,
    PORT: port,
  },
});
app.on("close", (code) => process.exit(code ?? 0));
