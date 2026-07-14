#!/usr/bin/env node
/**
 * Build the app with the vendored Encore toolchain: no `encore` CLI.
 *
 * Drives `tsparser-encore` (vendor/encore, built by `npm run build:runtime`)
 * over its stdin/stdout protocol:
 *
 *   prepare  -> pins the encore.dev dep to the vendored JS runtime and
 *               ensures node_modules is installed
 *   parse    -> emits the app metadata protobuf   -> .encore/build/meta
 *   compile  -> regenerates encore.gen and bundles the combined entrypoint
 *               (via scripts/encore/tsbundler.mjs) -> .encore/build/combined/
 *
 * Protocol framing (tsparser/src/bin/tsparser-encore.rs): each request is a
 * command line ("prepare\n") immediately followed by its JSON payload with
 * NO trailing newline (a bare newline is read as the end-of-input sentinel).
 * Each response is [u32 LE length][status byte 0=ok|1=err][payload], where
 * length = payload length + 1.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vendorDir = join(repoRoot, "vendor/encore");
// Overridable for worktree builds (scripts/docker-build.sh): the toolchain
// binaries live in the main checkout's gitignored target/ and node_modules.
const tsparserBin =
  process.env.ENCORE_TSPARSER_BIN ?? join(vendorDir, "target/release/tsparser-encore");
const tsbundler = process.env.ENCORE_TSBUNDLER_PATH ?? join(repoRoot, "scripts/encore/tsbundler.mjs");
const buildDir = join(repoRoot, ".encore/build");
const RUNTIME_VERSION = "v1.57.9";

if (!existsSync(tsparserBin)) {
  console.error(`tsparser-encore not found at ${tsparserBin}`);
  console.error("build the vendored toolchain first: npm run build:runtime");
  process.exit(1);
}

// Guard against stray CMake *.ts artifacts in the cargo target trees (see
// link-runtime.mjs); the parse walk would otherwise fail on them.
for (const t of ["target", "target-linux"]) {
  if (existsSync(join(vendorDir, t))) {
    spawnSync("find", [join(vendorDir, t), "-name", "*.ts", "-type", "f", "-delete"]);
  }
}

const child = spawn(tsparserBin, [], {
  cwd: repoRoot,
  env: { ...process.env, ENCORE_TSBUNDLER_PATH: tsbundler },
  stdio: ["pipe", "pipe", "inherit"],
});

// --- response framing ------------------------------------------------------
let buf = Buffer.alloc(0);
const waiters = [];
child.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const ok = buf[4] === 0;
    const payload = buf.subarray(5, 4 + len);
    buf = buf.subarray(4 + len);
    const waiter = waiters.shift();
    if (waiter) waiter({ ok, payload });
  }
});
const exited = new Promise((resolveExit) => child.on("close", resolveExit));

function request(cmd, payload) {
  return new Promise((resolveReq, rejectReq) => {
    waiters.push(({ ok, payload: body }) => {
      if (ok) resolveReq(body);
      else rejectReq(new Error(`${cmd} failed:\n${body.toString()}`));
    });
    // Command line, then the JSON payload with no trailing newline.
    child.stdin.write(`${cmd}\n${JSON.stringify(payload)}`);
  });
}

// --- the build pipeline ----------------------------------------------------
try {
  const prepared = await request("prepare", {
    app_root: repoRoot,
    runtime_version: RUNTIME_VERSION,
    local_runtime_override: join(vendorDir, "runtimes/js"),
  });
  console.log(`[encore-build] prepared (${prepared.length} bytes of package state)`);

  const meta = await request("parse", {
    app_root: repoRoot,
    platform_id: null,
    local_id: "enrahitu",
    parse_tests: false,
  });
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, "meta"), meta);
  console.log(`[encore-build] app metadata: .encore/build/meta (${meta.length} bytes)`);

  const compiled = await request("compile", {
    debug: "disabled",
    nodejs_runtime: "nodejs",
  });
  const result = JSON.parse(compiled.toString());
  writeFileSync(join(buildDir, "compile-result.json"), JSON.stringify(result, null, 2));
  for (const output of result.outputs) {
    for (const entrypoint of output.entrypoints) {
      const cmd = entrypoint.cmd.command
        .map((c) => c.replace("$ARTIFACT_DIR", output.artifact_dir))
        .join(" ");
      console.log(`[encore-build] entrypoint: ${cmd}`);
    }
  }
} catch (err) {
  console.error(String(err.message ?? err));
  child.stdin.end();
  await exited;
  process.exit(1);
}

child.stdin.end(); // end-of-input: tsparser exits cleanly
const code = await exited;
process.exit(code ?? 0);
