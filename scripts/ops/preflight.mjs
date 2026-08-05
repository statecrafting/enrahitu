#!/usr/bin/env node
/**
 * `preflight`: the conditions that must hold before anything starts (spec 027 §3.5).
 *
 * Every check here corresponds to a failure this substrate has actually produced
 * late and confusingly. A root-owned volume surfaces as a crash inside first-boot
 * rather than as "the volume is not yours"; a ledger URL with no scheme surfaces
 * as a driver error after rauthy is already up; an occupied port surfaces as a
 * die-together restart loop with the real cause three screens back. Stating the
 * precondition costs one process at boot and turns each of those into a sentence.
 *
 *   node scripts/ops/preflight.mjs      # the verb; exit code is the verdict
 *
 * The entrypoint calls it and fails closed (spec 027 §3.5), which is why this is
 * a plain node script with no dependencies of its own: it runs before anything
 * else, in the packaged image where only production `node_modules` exist, and in
 * the dev container's first boot where `npm ci` has not run yet. Anything that
 * needs a dependency (the ledger's applied-migration state) degrades to a report
 * rather than a failure, because a verb that fails closed must never fail closed
 * on its own missing tooling.
 *
 * Two of the six conditions are reported rather than judged, and the split is
 * deliberate:
 *
 * - **Judged** (exit nonzero): a declared required variable is missing, the
 *   public URL is unusable, the data directory is not writable, the ledger URL
 *   names no driver, a port the entrypoint will bind is taken. Each of these
 *   makes the boot that follows wrong or impossible.
 * - **Reported** (exit zero, said out loud): plain http on a non-loopback host,
 *   and the pending-migration count. The first is a legitimate deployment (an
 *   association on a box behind its own TLS terminator, or a LAN trial) that
 *   an operator should nonetheless see named; the second is information a deploy
 *   step acts on, not a precondition of booting.
 */
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The entrypoint's own default, so the verb models the boot it precedes. */
const DEFAULT_PUBLIC_URL = "http://localhost:8080";
/** `backend/core/ledger/from-env.ts`'s default, for the same reason. */
const DEFAULT_LEDGER_URL = "file:./.data/ledger/enrahitu.db";
const DEFAULT_DATA_DIR = "/data";
/** The declared home the `migrate` verb executes against (spec 027 §3.4). */
const MIGRATION_HOME = "backend/core/ledger/migration-list.ts";

/**
 * Scheme to driver, matching `rawDriverFromEnv()` exactly.
 *
 * That function routes everything that is not Postgres to libSQL, so an
 * unknown scheme does not fail there: it becomes a libSQL client that throws
 * later, with a message about the URL rather than about the configuration. The
 * table is closed here on purpose, which is the whole difference between the
 * two: a scheme nobody meant to type is named now instead of at first query.
 */
const DRIVERS = {
  "postgres:": "postgres",
  "postgresql:": "postgres",
  "file:": "libsql",
  "libsql:": "libsql",
  "http:": "libsql",
  "https:": "libsql",
  "ws:": "libsql",
  "wss:": "libsql",
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** How long the ledger may take to answer before its state is called unknown. */
const LEDGER_PROBE_MS = 3_000;

const result = (status) => (name, detail) => ({ name, status, detail });
const pass = result("pass");
const fail = result("fail");
const warn = result("warn");
const info = result("info");

/** uid for a message, since the failure it explains is almost always ownership. */
function runningAs() {
  const uid = process.getuid?.();
  return uid === undefined ? "this process" : `uid ${uid}`;
}

/**
 * A URL safe to print. A Postgres ledger URL carries a password, and a verb
 * whose whole job is to be read in a boot log must not be the thing that puts
 * one there.
 */
function redact(raw) {
  try {
    const url = new URL(raw);
    if (!url.password) return raw;
    url.password = "***";
    return url.href;
  } catch {
    return raw;
  }
}

// --- the checks -------------------------------------------------------------

/**
 * Every name in `ENRAHITU_REQUIRED_ENV` is set and non-empty.
 *
 * This is spec 007's fleet-declared pre-flight, promoted out of the entrypoint
 * so it can run outside it (spec 027 §3.5). The entrypoint now calls the verb
 * rather than keeping its own copy: two implementations of a fleet-facing
 * contract are two implementations that drift, and the one in bash was the one
 * nothing could test.
 *
 * Empty counts as missing, matching the `-z` test it replaces. All missing
 * names report together, because an operator fixing them one boot at a time is
 * the failure mode this check exists to end.
 */
export function checkRequiredEnv(env) {
  const declared = (env.ENRAHITU_REQUIRED_ENV ?? "").split(/[,\s]+/).filter(Boolean);
  if (declared.length === 0) {
    return pass("required-env", "no names declared in ENRAHITU_REQUIRED_ENV");
  }
  const missing = declared.filter((name) => !env[name]);
  if (missing.length > 0) {
    return fail("required-env", `not set or empty: ${missing.join(", ")}`);
  }
  return pass("required-env", `${declared.length} declared name(s) present`);
}

/**
 * `ENRAHITU_PUBLIC_URL` parses, and its scheme is consistent with the cookie
 * mode the entrypoint would select.
 *
 * The entrypoint branches on `https` and treats everything else as plain http:
 * rauthy gets `COOKIE_MODE=danger-insecure` and the app omits `Secure` from its
 * session cookies (`backend/lib/cookie-config.ts` keys on the same scheme).
 * That branch is correct for a local trial and catastrophic for a public
 * deployment, and the two are told apart by nothing except this value.
 *
 * A scheme that is neither http nor https is refused rather than warned about,
 * because it lands in the plain-http branch silently: `localhost:8080` with no
 * scheme parses as a URL whose protocol is `localhost:`, and the entrypoint
 * would run a public deployment with insecure cookies on the strength of a
 * missing `//`.
 */
export function checkPublicUrl(env) {
  const raw = env.ENRAHITU_PUBLIC_URL || DEFAULT_PUBLIC_URL;
  const source = env.ENRAHITU_PUBLIC_URL ? "ENRAHITU_PUBLIC_URL" : "the entrypoint's default";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail("public-url", `${redact(raw)} (${source}) is not a URL`);
  }
  const scheme = url.protocol.replace(/:$/, "");
  if (url.protocol === "https:") {
    return pass("public-url", `${redact(raw)}: rauthy takes PROXY_MODE, cookies are Secure`);
  }
  if (url.protocol !== "http:") {
    return fail(
      "public-url",
      `scheme "${scheme}" (${source}) is neither http nor https; the entrypoint treats ` +
        `every non-https value as plain http, so this would boot with rauthy in ` +
        `danger-insecure cookie mode. A missing "//" parses as a scheme.`,
    );
  }
  if (LOOPBACK_HOSTS.has(url.hostname)) {
    return pass(
      "public-url",
      `${redact(raw)}: a loopback trial, so rauthy takes danger-insecure cookies by design`,
    );
  }
  return warn(
    "public-url",
    `${redact(raw)} is plain http on a non-loopback host (${url.hostname}): rauthy will run ` +
      `in danger-insecure cookie mode and session cookies will not be marked Secure. ` +
      `Terminate TLS in front of this container and set an https URL.`,
  );
}

/**
 * The data directory exists and is writable by the runtime user.
 *
 * The legacy failure this replaces is a volume created by the pre-2026-07-23
 * root image and then mounted into the non-root one (spec 007): everything
 * looks right until first-boot tries to write a key and dies. Naming the
 * owning uid alongside the running one turns a stack trace into the one-line
 * `chown` that fixes it.
 *
 * A missing directory is not a failure when its parent is writable, because
 * that is exactly the state a fresh volume mount is in and first-boot creates
 * the tree on its next line.
 */
export function checkDataDir(env) {
  const dir = env.ENRAHITU_DATA_DIR || DEFAULT_DATA_DIR;
  if (!existsSync(dir)) {
    const parent = dirname(dir);
    if (!existsSync(parent)) {
      return fail("data-dir", `${dir} does not exist and neither does ${parent}`);
    }
    try {
      accessSync(parent, constants.W_OK | constants.X_OK);
    } catch {
      return fail("data-dir", `${dir} does not exist and ${parent} is not writable by ${runningAs()}`);
    }
    return pass("data-dir", `${dir} does not exist yet; ${parent} is writable, so first-boot creates it`);
  }
  const stats = statSync(dir);
  if (!stats.isDirectory()) {
    return fail("data-dir", `${dir} is not a directory`);
  }
  try {
    accessSync(dir, constants.W_OK | constants.X_OK);
  } catch {
    const mode = (stats.mode & 0o777).toString(8);
    return fail(
      "data-dir",
      `${dir} is not writable by ${runningAs()}: owned by ${stats.uid}:${stats.gid}, mode ${mode}. ` +
        `A volume written by an older root image needs a one-time chown -R 1000:1000.`,
    );
  }
  return pass("data-dir", `${dir} is writable by ${runningAs()}`);
}

/** The ledger URL parses and its scheme maps to a driver. */
export function checkLedgerUrl(env) {
  const raw = env.ENRAHITU_LEDGER_URL || DEFAULT_LEDGER_URL;
  const source = env.ENRAHITU_LEDGER_URL ? "ENRAHITU_LEDGER_URL" : "the CoreLedger default";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail(
      "ledger-url",
      `${redact(raw)} (${source}) is not a URL. A bare filesystem path is not one: ` +
        `write file:/data/ledger/enrahitu.db.`,
    );
  }
  const driver = DRIVERS[url.protocol];
  if (!driver) {
    return fail(
      "ledger-url",
      `no driver for scheme "${url.protocol.replace(/:$/, "")}" (${source}); ` +
        `CoreLedger knows ${Object.keys(DRIVERS)
          .map((s) => s.replace(/:$/, ""))
          .join(", ")}`,
    );
  }
  return pass("ledger-url", `${redact(raw)} maps to the ${driver} driver`);
}

/**
 * The addresses the entrypoint will bind.
 *
 * Derived from the environment rather than listed as constants, because the
 * app's port is not fixed: the Encore runtime takes `ENCORE_LISTEN_ADDR`, then
 * `PORT`, and only then defaults to 8080, so the packaged image binds 8080 and
 * the dev topology (spec 033) binds 4000. Checking a hardcoded 8080 in the dev
 * container would test a port nothing was going to use and pass over the one
 * that mattered.
 *
 * rauthy's three are constants because they are constants: `LISTEN_PORT_HTTP`
 * is set by the entrypoint and the hiqlite pair by
 * `docker/rauthy/config.prod.toml`'s single-node cluster line.
 */
export function plannedPorts(env) {
  const app = env.ENCORE_LISTEN_ADDR
    ? splitAddr(env.ENCORE_LISTEN_ADDR, "0.0.0.0", 8080)
    : { host: "0.0.0.0", port: Number(env.PORT) || 8080 };
  return [
    { label: "app", ...app },
    { label: "rauthy http", host: "127.0.0.1", port: 8081 },
    { label: "rauthy hiqlite raft", host: "127.0.0.1", port: 8100 },
    { label: "rauthy hiqlite api", host: "127.0.0.1", port: 8200 },
    { label: "app hiqlite raft", ...splitAddr(env.ENRAHITU_HIQ_ADDR_RAFT, "127.0.0.1", 8300) },
    { label: "app hiqlite api", ...splitAddr(env.ENRAHITU_HIQ_ADDR_API, "127.0.0.1", 8400) },
  ];
}

/** `host:port` into its parts, falling back whole rather than half-parsed. */
function splitAddr(addr, fallbackHost, fallbackPort) {
  if (!addr) return { host: fallbackHost, port: fallbackPort };
  const idx = addr.lastIndexOf(":");
  if (idx < 0) return { host: fallbackHost, port: Number(addr) || fallbackPort };
  const host = addr.slice(0, idx) || fallbackHost;
  const port = Number(addr.slice(idx + 1)) || fallbackPort;
  return { host, port };
}

/**
 * Can this process bind the address? `exclusive` so the answer is the same one
 * the supervised process will get rather than a shared-socket courtesy.
 */
export function probePort(host, port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** Every port the entrypoint will bind is free. */
export async function checkPorts(env, { ports = plannedPorts(env), probe = probePort } = {}) {
  const probed = await Promise.all(
    ports.map(async (entry) => ({ ...entry, free: await probe(entry.host, entry.port) })),
  );
  const busy = probed.filter((entry) => !entry.free);
  if (busy.length > 0) {
    return fail(
      "ports",
      `already in use: ${busy.map((entry) => `${entry.host}:${entry.port} (${entry.label})`).join(", ")}`,
    );
  }
  return pass("ports", `${probed.length} port(s) free: ${probed.map((entry) => entry.port).join(", ")}`);
}

/**
 * The declared migration versions, read from the home the `migrate` verb runs.
 *
 * Loaded by path with Node's own type stripping rather than through the app,
 * because this verb runs before the app exists as a process. That is why the
 * home's module-level imports must stay type-only: an erased import costs
 * nothing here, and a value import to an extensionless specifier is
 * unresolvable outside the bundler. The test beside this file holds that line.
 */
export async function loadDeclaredMigrations(root = repoRoot) {
  const home = join(root, MIGRATION_HOME);
  try {
    const mod = await import(pathToFileURL(home).href);
    const list = mod.CORE_LEDGER_MIGRATIONS;
    if (!Array.isArray(list)) {
      return { error: `${MIGRATION_HOME} exports no CORE_LEDGER_MIGRATIONS array` };
    }
    return { migrations: list.map((m) => ({ version: m.version, name: m.name })) };
  } catch (err) {
    return { error: `${MIGRATION_HOME}: ${err.message}` };
  }
}

/**
 * The versions `_coreledger_migrations` records as applied.
 *
 * Every failure here returns `{ error }` rather than throwing, and the caller
 * reports it. A ledger that cannot be reached at pre-flight is not a reason to
 * refuse a boot: a Postgres topology's server may still be coming up, and the
 * dev container's first boot reaches this line before `npm ci` has put a driver
 * on disk at all.
 */
export async function readAppliedVersions(env) {
  const raw = env.ENRAHITU_LEDGER_URL || DEFAULT_LEDGER_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: "the ledger URL does not parse" };
  }
  const driver = DRIVERS[url.protocol];
  if (!driver) return { error: "the ledger URL names no driver" };

  // A file: ledger that does not exist yet has applied nothing, and opening it
  // to learn that would create it. Nothing else in pre-flight writes to the
  // volume and this must not be the exception.
  if (url.protocol === "file:" && !existsSync(raw.slice("file:".length))) {
    return { versions: [], note: "no ledger file yet" };
  }

  const sql = 'SELECT version FROM "_coreledger_migrations" ORDER BY version ASC';
  try {
    return await withTimeout(
      driver === "postgres" ? postgresVersions(raw, sql) : libsqlVersions(raw, sql),
      LEDGER_PROBE_MS,
    );
  } catch (err) {
    return { error: err.message };
  }
}

async function libsqlVersions(url, sql) {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url });
  try {
    const rows = await client.execute(sql);
    return { versions: rows.rows.map((row) => Number(row.version)) };
  } catch (err) {
    if (/no such table/i.test(err.message)) return { versions: [], note: "no migrations table yet" };
    throw err;
  } finally {
    client.close();
  }
}

async function postgresVersions(url, sql) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: LEDGER_PROBE_MS });
  await client.connect();
  try {
    const { rows } = await client.query(sql);
    return { versions: rows.map((row) => Number(row.version)) };
  } catch (err) {
    // 42P01: undefined_table. Nothing has been applied, which is a state and
    // not an error.
    if (err.code === "42P01") return { versions: [], note: "no migrations table yet" };
    throw err;
  } finally {
    await client.end();
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`the ledger did not answer within ${ms}ms`)), ms).unref(),
    ),
  ]);
}

/**
 * Pending migrations exist or do not, reported rather than judged (spec 027
 * §3.5). Migration is a deploy step and not a boot step (§3.4), so this
 * decides nothing; it says what the next deploy step has to do.
 */
export async function checkMigrations(env, opts = {}) {
  const declared = await (opts.declared ?? loadDeclaredMigrations)();
  if (declared.error) {
    return info("migrations", `declared list unreadable: ${declared.error}`);
  }
  const applied = await (opts.applied ?? readAppliedVersions)(env);
  const count = declared.migrations.length;
  if (applied.error) {
    return info("migrations", `${count} declared; applied state unknown (${applied.error})`);
  }
  const pending = declared.migrations.filter((m) => !applied.versions.includes(m.version));
  const where = applied.note ? ` (${applied.note})` : "";
  if (pending.length === 0) {
    return info("migrations", `${count} declared, all applied${where}`);
  }
  return info(
    "migrations",
    `${pending.length} pending of ${count} declared${where}: ` +
      `${pending.map((m) => `${m.version} ${m.name}`).join(", ")}. Run the migrate verb.`,
  );
}

// --- the verb ---------------------------------------------------------------

/**
 * Run every check and return them in order. Never throws: an unexpected error
 * inside a check becomes that check's failure, because a pre-flight that dies
 * with a stack trace has told the operator less than one that names the
 * condition it was on.
 */
export async function preflight(env = process.env, opts = {}) {
  const checks = [
    guard("required-env", () => checkRequiredEnv(env)),
    guard("public-url", () => checkPublicUrl(env)),
    guard("data-dir", () => checkDataDir(env)),
    guard("ledger-url", () => checkLedgerUrl(env)),
    await guardAsync("ports", () => checkPorts(env, opts.ports)),
    await guardAsync("migrations", () => checkMigrations(env, opts.migrations)),
  ];
  return { ok: checks.every((entry) => entry.status !== "fail"), checks };
}

function guard(name, run) {
  try {
    return run();
  } catch (err) {
    return fail(name, `check failed: ${err.message}`);
  }
}

async function guardAsync(name, run) {
  try {
    return await run();
  } catch (err) {
    return fail(name, `check failed: ${err.message}`);
  }
}

const LABEL = { pass: "ok  ", warn: "warn", fail: "FAIL", info: "note" };

export function format(checks) {
  const width = Math.max(...checks.map((entry) => entry.name.length));
  return checks.map(
    (entry) => `[preflight] ${LABEL[entry.status]} ${entry.name.padEnd(width)}  ${entry.detail}`,
  );
}

const invokedDirectly =
  import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;

if (invokedDirectly) {
  const { ok, checks } = await preflight();
  const lines = format(checks);
  // Failures go to stderr so a container log filtered to errors still carries
  // the reason the boot stopped; everything else is ordinary boot narration.
  checks.forEach((entry, idx) => {
    if (entry.status === "fail") console.error(lines[idx]);
    else console.log(lines[idx]);
  });
  const failed = checks.filter((entry) => entry.status === "fail");
  if (!ok) {
    console.error(
      `[preflight] refusing to start: ${failed.length} of ${checks.length} conditions unmet`,
    );
    process.exit(1);
  }
  console.log(`[preflight] ${checks.length} conditions checked, none blocking`);
}
