#!/usr/bin/env node
/**
 * The backend watch loop (spec 033 §3.4).
 *
 * The toolchain's dev runner builds once and runs, so every backend edit is a
 * manual full rebuild. The frontend has Vite HMR and the backend has nothing,
 * which is an asymmetry nobody chose: it is simply what the runner was, and it
 * was tolerable while `npm run dev` was a thing a developer restarted by hand
 * anyway. Inside a container it stops being tolerable, because the restart is
 * no longer one keystroke away.
 *
 * This watches the backend sources, debounces, rebuilds through the toolchain
 * driver, and restarts the app. It lives here rather than in the toolchain
 * because what counts as a source change is an application concern and the
 * toolchain ships on its own cadence.
 *
 *   node scripts/dev-watch.mjs
 *
 * There is no hot module replacement and there is not meant to be: an
 * in-process module swap under a napi runtime holding a raft node is a much
 * larger problem than it looks, and the rebuild is seconds.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { augmentInfraConfig } from "@statecrafting/toolchain/augment-infra";
import { runtimeLib as resolveRuntimeLib } from "@statecrafting/toolchain/resolve";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories whose contents feed the Encore build. */
const WATCHED = ["backend", "app-manifest.json", "encore.app", "tsconfig.json"];

/** Debounce window: an editor "save all" is many events and one rebuild. */
const DEBOUNCE_MS = Number(process.env.ENRAHITU_WATCH_DEBOUNCE_MS ?? 250);

const PORT = process.env.PORT ?? "4000";

function log(msg) {
  console.log(`[dev-watch] ${msg}`);
}

/**
 * Resolve a toolchain bin without assuming node_modules/.bin is on PATH, which
 * it is not when this is spawned as a container's app process rather than
 * through an npm script.
 *
 * Absent, this throws rather than falling back to the bare name. The fallback
 * was worse than useless: `spawnSync(node, ["enrahitu-build"])` treats the
 * argument as a FILE PATH, so a missing toolchain surfaced as
 * `Cannot find module '/workspace/enrahitu-build'`, which points at the wrong
 * problem entirely. The real cause is a devDependency that was not installed,
 * and the message should say so.
 */
function toolchainBin(name) {
  const direct = join(repoRoot, "node_modules", ".bin", name);
  if (existsSync(direct)) return direct;
  throw new Error(
    `${name} not found at ${direct}. The build toolchain is a devDependency, so ` +
      `an install that ran with NODE_ENV=production omitted it. Re-run \`npm ci\` ` +
      `with NODE_ENV unset or set to development.`,
  );
}

let child = null;
let building = false;
let pendingRebuild = false;
let timer = null;

function stopApp() {
  if (child === null) return Promise.resolve();
  const dying = child;
  child = null;
  return new Promise((resolve) => {
    const kill = setTimeout(() => dying.kill("SIGKILL"), 5_000);
    dying.on("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    dying.kill("SIGTERM");
  });
}

/**
 * The runtime environment the bundle needs, mirroring what the toolchain's own
 * dev runner sets. Without it the app dies at import with "The
 * ENCORE_RUNTIME_LIB environment variable is not set", because a compiled
 * bundle is not self-contained: it needs the napi runtime, the app metadata
 * from the parse step, and an infra config with the hosted services and
 * gateways merged in (absent those, the runtime hosts nothing).
 */
function runtimeEnv() {
  const lib = process.env.ENCORE_RUNTIME_LIB ?? resolveRuntimeLib({ cwd: repoRoot });
  if (!lib) throw new Error("encore-runtime.node not resolvable; is the toolchain installed?");
  const infraPath = join(repoRoot, ".encore/build/infra.config.runtime.json");
  augmentInfraConfig(
    join(repoRoot, "infra.config.dev.json"),
    join(repoRoot, ".encore/build/compile-result.json"),
    infraPath,
  );
  return {
    ENCORE_RUNTIME_LIB: lib,
    ENCORE_APP_META_PATH: join(repoRoot, ".encore/build/meta"),
    ENCORE_INFRA_CONFIG_PATH: infraPath,
  };
}

function startApp() {
  const main = join(repoRoot, ".encore/build/combined/combined/main.mjs");
  if (!existsSync(main)) {
    log("no bundle to run; waiting for the next successful build");
    return;
  }
  let runtime;
  try {
    runtime = runtimeEnv();
  } catch (err) {
    log(`cannot start: ${err.message}`);
    return;
  }
  child = spawn(process.execPath, ["--enable-source-maps", main], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...runtime, PORT },
  });
  child.on("exit", (code, signal) => {
    // A crash must not take the watcher down with it: the whole value of a
    // watch loop is that the next edit is what fixes the crash.
    if (child !== null && signal === null && code !== 0) {
      log(`app exited with ${code}; waiting for the next change`);
      child = null;
    }
  });
}

function build() {
  let bin;
  try {
    bin = toolchainBin("enrahitu-build");
  } catch (err) {
    log(err.message);
    return false;
  }
  const res = spawnSync(process.execPath, [bin], { cwd: repoRoot, stdio: "inherit" });
  return res.status === 0;
}

async function rebuild(reason) {
  if (building) {
    pendingRebuild = true;
    return;
  }
  building = true;
  try {
    log(reason);
    await stopApp();
    if (build()) startApp();
    else log("build failed; keeping the previous bundle stopped until it compiles");
  } finally {
    building = false;
    if (pendingRebuild) {
      pendingRebuild = false;
      await rebuild("changes arrived during the last build");
    }
  }
}

function schedule(path) {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void rebuild(`rebuilding: ${path}`);
  }, DEBOUNCE_MS);
}

function isSource(file) {
  if (!file) return false;
  // Test files do not change the built bundle, and rebuilding on every edit to
  // one turns a test-writing session into a restart loop.
  if (file.endsWith(".test.ts")) return false;
  return file.endsWith(".ts") || file.endsWith(".json") || file.endsWith(".app");
}

log(`starting on port ${PORT}`);
await rebuild("initial build");

for (const target of WATCHED) {
  const abs = join(repoRoot, target);
  if (!existsSync(abs)) continue;
  watch(abs, { recursive: true }, (_event, file) => {
    const name = file ? String(file) : target;
    if (!isSource(name)) return;
    schedule(relative(repoRoot, join(abs, name)));
  });
}
log(`watching ${WATCHED.join(", ")}`);

// The container stops this process, not the app: forward so hiqlite releases
// its lock files cleanly (the failure spec 007 documents at length).
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`received ${sig}; stopping`);
    void stopApp().then(() => process.exit(0));
  });
}
