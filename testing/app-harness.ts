/**
 * The app-level test harness (spec 033): boot the real compiled application and
 * talk to it over HTTP.
 *
 * Every other test in this repo is either a pure module test or a subprocess
 * test of a shell script. Neither can answer the question "does the running
 * gateway refuse this request?", which is the only question that matters for a
 * surface reachable by a stranger. Spec 025 shipped four acceptance items it
 * could not prove for exactly that reason.
 *
 * This harness boots `.encore/build/combined/combined/main.mjs`, the same
 * bundle `enrahitu-dev` runs and the same one the container runs, under a
 * throwaway data directory with freshly minted keys. Requests go over real
 * HTTP through the real gateway, so middleware, the auth handler, the kernel,
 * and the Encore router are all in the path. Nothing is stubbed.
 *
 * Cost and consequences, stated because they shape how it should be used:
 *
 * - Boot takes several seconds, most of it the hiqlite raft election. Start ONE
 *   instance per test file in `beforeAll`, never per test.
 * - It needs a prior `npm run build:app`. Without one, `isAppBuilt()` is false
 *   and suites should skip rather than fail: CI always builds first
 *   (verify.yml), a developer may not have.
 * - Ports are allocated from the OS, and the data directory is per-instance, so
 *   parallel vitest workers do not collide.
 *
 * It lives at the repo root rather than under `backend/` on purpose. The
 * extractor's usage walk treats every non-`.test.ts` file under `backend/` as
 * application code, and rightly refuses bare `fetch()` there: ungoverned egress
 * from an app service is exactly what `backend/kernel/egress.ts` exists to
 * prevent. A harness whose entire job is to make HTTP requests at the app from
 * outside is not application code, and putting it under `backend/` would have
 * meant either weakening that ban or lying about what this file is. `e2e/`
 * (spec 017) is the existing precedent for root-level test infrastructure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { augmentInfraConfig } from "@statecrafting/toolchain/augment-infra";
import { runtimeLib as resolveRuntimeLib } from "@statecrafting/toolchain/resolve";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(repoRoot, ".encore/build/combined/combined/main.mjs");
const metaPath = join(repoRoot, ".encore/build/meta");
const compileResult = join(repoRoot, ".encore/build/compile-result.json");

/** Whether `npm run build:app` has produced the artifacts this harness boots. */
export function isAppBuilt(): boolean {
  return existsSync(bundle) && existsSync(metaPath) && existsSync(compileResult);
}

/** Ask the OS for a free port, then release it. Racy in principle, fine here. */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close(() => rej(new Error("no port assigned")));
        return;
      }
      const { port } = addr;
      srv.close(() => res(port));
    });
  });
}

/**
 * The RS256 pairs `backend/lib/secrets.ts` falls back to when the Encore secret
 * is unset, written into the instance's own keys dir (ENRAHITU_KEYS_DIR). Same
 * shape as scripts/generate-keys.ts; inlined rather than shelled out so a test
 * run spawns one process instead of two.
 */
function writeKeys(keysDir: string): void {
  for (const prefix of ["access", "refresh"]) {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    writeFileSync(join(keysDir, `${prefix}-private.pem`), privateKey, { mode: 0o600 });
    writeFileSync(join(keysDir, `${prefix}-public.pem`), publicKey, { mode: 0o644 });
  }
}

/**
 * A minimal cookie jar. The app's session is httpOnly cookies (spec 004) and
 * `fetch` does not persist them, so a harness without a jar cannot represent a
 * signed-in user and could only ever test the unauthenticated surface.
 */
class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // An expiry in the past is a deletion; treat it as one so logout is
      // observable in the jar rather than leaving a stale session behind.
      if (/;\s*max-age=0/i.test(raw) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  clear(): void {
    this.cookies.clear();
  }
}

export interface AppInstance {
  readonly baseUrl: string;
  readonly metricsToken: string;
  readonly jar: CookieJar;
  /** fetch against the instance, carrying and absorbing cookies. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** GET the CSRF token and replay it as the X-CSRF-Token header. */
  fetchWithCsrf(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Auth driver for the instance. "mock" gives deterministic sign-in. */
  authDriver?: string;
  /** Extra environment for the app process. */
  env?: Record<string, string>;
  /** Milliseconds to wait for /healthz before giving up. */
  readyTimeoutMs?: number;
}

/**
 * Boot one application instance. Resolves once `/healthz` answers, which is the
 * liveness probe and deliberately touches no dependency (spec 025 §3.3); a
 * caller that needs the ledger up should poll `/readyz` itself.
 */
export async function startApp(opts: StartOptions = {}): Promise<AppInstance> {
  if (!isAppBuilt()) {
    throw new Error("app bundle missing: run `npm run build:app` before the app-level suite");
  }

  const dataDir = mkdtempSync(join(tmpdir(), "enrahitu-app-"));
  const keysDir = join(dataDir, "keys");
  const hiqDir = join(dataDir, "hiq");
  mkdirSync(keysDir, { recursive: true });
  mkdirSync(hiqDir, { recursive: true });
  writeKeys(keysDir);

  const [port, raftPort, apiPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const infraPath = join(dataDir, "infra.config.json");
  augmentInfraConfig(join(repoRoot, "infra.config.dev.json"), compileResult, infraPath);

  const runtime = process.env.ENCORE_RUNTIME_LIB ?? resolveRuntimeLib({ cwd: repoRoot });
  if (!runtime) throw new Error("encore-runtime.node not resolvable; is the toolchain installed?");

  const metricsToken = `harness-${port}`;

  // The child must NOT inherit the test runner's environment wholesale.
  // Vitest sets NODE_ENV=test and a family of VITEST_* markers; inherited,
  // they put the Encore runtime in test mode, where it never opens its API
  // listener. The symptom is a boot that logs nothing and times out, which
  // reads like a hung app rather than a misconfigured one.
  //
  // NODE_ENV is then stated explicitly, and "development" is the only correct
  // default: "test" is the trap above, and "production" disables the mock auth
  // driver (`isMockEnabled()` is `!env.isProduction`), leaving the harness
  // unable to hold a session. Callers wanting production semantics pass
  // NODE_ENV through `opts.env`, which is how the mock-disabled-in-production
  // property is tested.
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "NODE_ENV" || k.startsWith("VITEST")) continue;
    inherited[k] = v;
  }

  const child: ChildProcess = spawn(process.execPath, ["--enable-source-maps", bundle], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...inherited,
      NODE_ENV: "development",
      ENCORE_RUNTIME_LIB: runtime,
      ENCORE_APP_META_PATH: metaPath,
      ENCORE_INFRA_CONFIG_PATH: infraPath,
      PORT: String(port),
      AUTH_DRIVER: opts.authDriver ?? "mock",
      ENRAHITU_KEYS_DIR: keysDir,
      ENRAHITU_LEDGER_URL: `file:${join(dataDir, "ledger.db")}`,
      ENRAHITU_HIQ_DATA_DIR: hiqDir,
      ENRAHITU_HIQ_ADDR_RAFT: `127.0.0.1:${raftPort}`,
      ENRAHITU_HIQ_ADDR_API: `127.0.0.1:${apiPort}`,
      ENRAHITU_METRICS_TOKEN: metricsToken,
      ...opts.env,
    },
  });

  // Retained so a boot failure reports what the app said rather than a bare
  // timeout, which is the difference between a five-second diagnosis and an
  // afternoon.
  let log = "";
  child.stdout?.on("data", (d: Buffer) => {
    log += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    log += d.toString();
  });

  let exited: number | null = null;
  child.on("exit", (code) => {
    exited = code ?? -1;
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const jar = new CookieJar();

  const stop = async (): Promise<void> => {
    if (exited !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((res) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        res();
      }, 5_000);
      child.on("exit", () => {
        clearTimeout(timer);
        res();
      });
    });
  };

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 60_000);
  for (;;) {
    if (exited !== null) {
      throw new Error(`app exited with ${exited} during boot:\n${log.slice(-3000)}`);
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`app did not become ready in time:\n${log.slice(-3000)}`);
    }
    try {
      // `/readyz` and NOT `/healthz`. Spec 025 separated the probes so that
      // liveness touches no dependency, which is exactly what makes `/healthz`
      // the wrong question here: it answers 200 as soon as the listener is up,
      // while the raft election this section already calls the dominant cost of
      // boot is still running. Gating on it hands back an instance whose FIRST
      // request pays the remainder of the boot, inside whatever test happens to
      // make it. Readiness checks the ledger and hiqlite, which is the question
      // `startApp` is actually asking.
      const res = await fetch(`${baseUrl}/readyz`);
      if (res.ok) break;
    } catch {
      // connection refused until the listener is up
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const instanceFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = jar.header();
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: "manual" });
    jar.absorb(res);
    return res;
  };

  const fetchWithCsrf = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const tokenRes = await instanceFetch("/api/v1/auth/csrf-token");
    const { token } = (await tokenRes.json()) as { token: string };
    const headers = new Headers(init.headers);
    headers.set("X-CSRF-Token", token);
    return instanceFetch(path, { ...init, headers });
  };

  return { baseUrl, metricsToken, jar, fetch: instanceFetch, fetchWithCsrf, stop };
}
