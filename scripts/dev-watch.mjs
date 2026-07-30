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
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
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

/**
 * Stop the running app and resolve once it is actually gone.
 *
 * Every guard below is here because its absence wedged the entire loop. The
 * failure has one shape: this promise never settles, so `rebuild` never
 * reaches its `finally`, `building` stays true forever, and every later change
 * takes the `if (building)` early return. The watcher is then alive, silent,
 * and useless, and the only tell is that the previous rebuild never printed an
 * outcome. Recovering it took a container restart, which is how a five-second
 * papercut became a habit.
 *
 * So: a process that has already exited is recognized rather than waited on,
 * and an absolute deadline settles the promise no matter what. Continuing with
 * a process that refused to die is worse than the alternative in theory and
 * much better in practice, because a duplicate app is a loud port conflict
 * while a deaf watcher looks exactly like code that does not work.
 */
function stopApp() {
  const dying = child;
  child = null;
  if (dying === null) return Promise.resolve();
  // `exit` has already fired and will not fire again; a listener added now
  // would wait forever.
  if (dying.exitCode !== null || dying.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(escalate);
      clearTimeout(abandon);
      resolve();
    };
    const escalate = setTimeout(() => {
      try {
        dying.kill("SIGKILL");
      } catch {
        finish();
      }
    }, 5_000);
    const abandon = setTimeout(() => {
      log(`app pid ${dying.pid} did not exit; continuing without it`);
      finish();
    }, 15_000);
    dying.once("exit", finish);
    try {
      dying.kill("SIGTERM");
    } catch {
      finish();
    }
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
  const proc = spawn(process.execPath, ["--enable-source-maps", main], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...runtime, PORT },
  });
  child = proc;
  proc.on("exit", (code, signal) => {
    // A crash must not take the watcher down with it: the whole value of a
    // watch loop is that the next edit is what fixes the crash.
    //
    // Identity, not nullness. Two things were wrong with checking `child !==
    // null`: a late exit from a process that had already been replaced would
    // clear the reference to its successor, and an exit by signal or with
    // status 0 was not cleared at all. That second case is the one that bit,
    // because it left `child` pointing at a corpse and the next `stopApp`
    // waiting on an `exit` event that had already been delivered.
    if (child !== proc) return;
    child = null;
    if (signal !== null) log(`app killed by ${signal}; waiting for the next change`);
    else if (code !== 0) log(`app exited with ${code}; waiting for the next change`);
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
    // Absorb the tree we are about to compile, so whichever detector fired
    // first does not leave the other one holding a stale fingerprint and
    // scheduling the same rebuild again the moment this one finishes.
    fingerprint = snapshot();
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

/**
 * Change detection, twice, because inotify alone is not dependable here.
 *
 * The sources are bind-mounted from the host, and events cross that boundary
 * on the filesystem driver's good behavior rather than on any guarantee. In
 * practice the watch delivers events for a while and then quietly stops: the
 * process is alive, the last rebuild succeeded, and edits simply produce
 * nothing. Nothing distinguishes that from "my change did not work", which is
 * what makes it expensive; the reflex is to debug the code.
 *
 * So `fs.watch` stays as the fast path, and a periodic fingerprint of the same
 * files is the floor. Content hashes rather than mtimes, because a build step
 * that rewrites a watched file byte-for-byte would otherwise drive the loop in
 * circles, and the whole watched tree is well under a megabyte of TypeScript.
 */
const POLL_DEFAULT_MS = 1000;
const configuredPoll = Number(process.env.ENRAHITU_WATCH_POLL_MS ?? POLL_DEFAULT_MS);
// A typo in the variable must not silently remove the floor: that would leave
// the loop depending on exactly the mechanism this exists to backstop, and the
// only evidence would be `polling every NaNms` in a line nobody rereads.
const POLL_MS = Number.isFinite(configuredPoll) && configuredPoll >= 0 ? configuredPoll : POLL_DEFAULT_MS;

/** Output and dependency trees, none of which is a source of the build. */
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-admin", ".encore", ".git", "coverage"]);

function hashFile(abs) {
  try {
    return createHash("sha1").update(readFileSync(abs)).digest("hex");
  } catch {
    // Raced with a write, or vanished. The next tick sees the settled state.
    return null;
  }
}

function isDirectory(abs) {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function snapshot() {
  const seen = new Map();
  const visit = (abs, rel) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(join(abs, entry.name), `${rel}/${entry.name}`);
      } else if (isSource(entry.name)) {
        const hash = hashFile(join(abs, entry.name));
        if (hash !== null) seen.set(`${rel}/${entry.name}`, hash);
      }
    }
  };
  for (const target of WATCHED) {
    const abs = join(repoRoot, target);
    if (!existsSync(abs)) continue;
    if (isDirectory(abs)) visit(abs, target);
    else if (isSource(target)) {
      const hash = hashFile(abs);
      if (hash !== null) seen.set(target, hash);
    }
  }
  return seen;
}

let fingerprint = new Map();

function poll() {
  // A build writes nothing under the watched paths, but skipping while one
  // runs keeps the pre-build fingerprint intact, so an edit that lands mid
  // build is still detected on the tick after it finishes.
  if (building) return;
  // Nothing in a scan is worth the loop's life. An interval callback that
  // throws is an uncaught exception, and the process this one belongs to is
  // the one thing keeping the container useful.
  let next;
  try {
    next = snapshot();
  } catch (err) {
    log(`poll failed: ${err.message}`);
    return;
  }
  let changed = null;
  for (const [file, hash] of next) {
    if (fingerprint.get(file) !== hash) {
      changed = file;
      break;
    }
  }
  if (changed === null && next.size !== fingerprint.size) {
    for (const file of fingerprint.keys()) {
      if (!next.has(file)) {
        changed = file;
        break;
      }
    }
  }
  fingerprint = next;
  if (changed !== null) schedule(changed);
}

log(`starting on port ${PORT}`);
await rebuild("initial build");
fingerprint = snapshot();

for (const target of WATCHED) {
  const abs = join(repoRoot, target);
  if (!existsSync(abs)) continue;
  const isDir = isDirectory(abs);
  watch(abs, { recursive: isDir }, (_event, file) => {
    // For a watched file rather than a directory, `file` is the basename, and
    // joining it onto its own path produced the `app-manifest.json/app-manifest.json`
    // that has been in the log since this loop shipped.
    const name = file ? String(file) : target;
    if (!isSource(name)) return;
    schedule(isDir ? relative(repoRoot, join(abs, name)) : target);
  });
}
// Deliberately not unref'd. The failure this backstops is `fs.watch` going
// quiet, and an unref'd timer would let the process exit at exactly the moment
// the watch handles stopped holding it open and no app child was running.
if (POLL_MS > 0) setInterval(poll, POLL_MS);
log(`watching ${WATCHED.join(", ")} (polling every ${POLL_MS}ms)`);

// The container stops this process, not the app: forward so hiqlite releases
// its lock files cleanly (the failure spec 007 documents at length).
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`received ${sig}; stopping`);
    void stopApp().then(() => process.exit(0));
  });
}
