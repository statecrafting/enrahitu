/**
 * The entrypoint's signal handling (spec 007).
 *
 * `docker/entrypoint.sh` is PID 1 in the shipped image, so container stop is
 * delivered to it and nothing else. Without a trap the shell dies alone and the
 * supervised processes are SIGKILLed at the end of the grace period, which
 * leaves rauthy's embedded hiqlite holding its WAL and state-machine lock
 * files and makes the next boot unclean. That is a shell-level guarantee with
 * no other coverage, so the real `shutdown` function is lifted out of the
 * shipped script and exercised against stub children here: the test breaks if
 * someone edits the function, not if someone edits a copy of it.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(HERE, "entrypoint.sh");

/** The `shutdown() { ... }` block verbatim, from `shutdown()` to its closing brace. */
function shutdownFunction(script: string): string {
  const start = script.indexOf("shutdown() {");
  if (start === -1) throw new Error("entrypoint.sh no longer defines shutdown()");
  const end = script.indexOf("\n}\n", start);
  if (end === -1) throw new Error("shutdown() is not closed at column 0");
  return script.slice(start, end + 3);
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "entrypoint-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the real shutdown function under two stub children that log the signal
 * they receive, deliver `signal` to the harness, and resolve with its exit
 * status and the log the children wrote.
 */
async function runHarness(
  signal: NodeJS.Signals,
  { startApp = true }: { startApp?: boolean } = {},
): Promise<{ code: number | null; log: string[] }> {
  const script = readFileSync(ENTRYPOINT, "utf8");
  const out = join(dir, "log");
  // `sleep 30 & wait $!` rather than a plain `sleep 30`: bash defers a trap
  // until the running foreground command returns, so a stub that slept in the
  // foreground would swallow the signal for 30 seconds and prove nothing.
  const stub = (label: string) =>
    `( trap 'echo ${label} >> "$OUT"; exit 0' TERM; sleep 30 & wait $! ) &`;
  const app = startApp
    ? `${stub("app-term")}\nAPP_PID=$!`
    : `# app not started yet: shutdown must cope with APP_PID unset`;

  const harness = join(dir, "harness.sh");
  writeFileSync(
    harness,
    [
      "#!/bin/bash",
      "set -euo pipefail",
      'OUT="$1"',
      stub("rauthy-term"),
      "RAUTHY_PID=$!",
      app,
      shutdownFunction(script),
      "trap 'shutdown SIGTERM' TERM",
      "trap 'shutdown SIGINT' INT",
      'echo ready >> "$OUT"',
      "set +e",
      startApp ? 'wait -n "$RAUTHY_PID" "$APP_PID"' : 'wait -n "$RAUTHY_PID"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const child = spawn("bash", [harness, out], { stdio: "ignore" });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));

  // Signal only once the traps are installed and the stubs are running.
  // Signalling early would deliver to a shell with no handler yet, which fails
  // as exit 143 and reads like a broken handler rather than a slow runner, so
  // the wait is generous and a timeout is raised as itself.
  let ready = false;
  for (let i = 0; i < 500 && !ready; i++) {
    try {
      ready = readFileSync(out, "utf8").includes("ready");
    } catch {
      /* not written yet */
    }
    if (!ready) await new Promise((r) => setTimeout(r, 20));
  }
  if (!ready) {
    child.kill("SIGKILL");
    throw new Error("harness never reported ready; signalling now would test nothing");
  }
  child.kill(signal);

  const code = await exited;
  const log = readFileSync(out, "utf8").trim().split("\n").filter(Boolean);
  return { code, log };
}

describe("entrypoint shutdown", () => {
  it("installs traps for both stop signals", () => {
    const script = readFileSync(ENTRYPOINT, "utf8");
    expect(script).toContain("trap 'shutdown SIGTERM' TERM");
    expect(script).toContain("trap 'shutdown SIGINT' INT");
  });

  it("forwards SIGTERM to rauthy and the app, then exits 0", async () => {
    const { code, log } = await runHarness("SIGTERM");
    expect(log).toContain("rauthy-term");
    expect(log).toContain("app-term");
    expect(code).toBe(0);
  }, 15_000);

  it("forwards SIGINT the same way", async () => {
    const { code, log } = await runHarness("SIGINT");
    expect(log).toContain("rauthy-term");
    expect(log).toContain("app-term");
    expect(code).toBe(0);
  }, 15_000);

  it("stops rauthy when the signal lands before the app has started", async () => {
    // The window between `RAUTHY_PID=$!` and the app launch: the trap is
    // already armed there, and an unset APP_PID must not break the handler.
    const { code, log } = await runHarness("SIGTERM", { startApp: false });
    expect(log).toContain("rauthy-term");
    expect(log).not.toContain("app-term");
    expect(code).toBe(0);
  }, 15_000);
});

/**
 * The mail passthrough (spec 026 §3.1, §4 items 1 and 2).
 *
 * Lifted out of the shipped script for the same reason `shutdown` is: the
 * assertion has to break when someone edits the entrypoint, not when someone
 * edits a copy of it. What is verified here is the mapping, because that is
 * where the defect would be. Delivery itself needs a relay and is exercised in
 * the dev topology against Mailpit (§3.3), not here.
 */
function bashFunction(script: string, name: string): string {
  const start = script.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`entrypoint.sh no longer defines ${name}()`);
  const end = script.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`${name}() is not closed at column 0`);
  return script.slice(start, end + 3);
}

/**
 * Call the real function inside a subshell, exactly as the entrypoint does, and
 * report the environment on both sides of that boundary.
 */
function runSmtp(env: Record<string, string>): { inner: string[]; outer: string[] } {
  const script = readFileSync(ENTRYPOINT, "utf8");
  const harness = join(dir, "smtp.sh");
  writeFileSync(
    harness,
    [
      "#!/bin/bash",
      "set -euo pipefail",
      bashFunction(script, "scrub_smtp_env"),
      bashFunction(script, "export_smtp_env"),
      // Both in the order the entrypoint runs them: scrub at top level, map
      // inside the subshell that becomes rauthy's environment.
      "scrub_smtp_env",
      '( export_smtp_env; env | grep "^SMTP_" | sort | sed "s/^/inner /" ) || true',
      // Back outside it is the app process's environment, which must be clean.
      'env | grep "^SMTP_" | sort | sed "s/^/outer /" || true',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const out = spawnSync("bash", [harness], { env: { ...process.env, ...env }, encoding: "utf8" });
  const lines = out.stdout.trim().split("\n").filter(Boolean);
  return {
    inner: lines.filter((l) => l.startsWith("inner ")).map((l) => l.slice(6)),
    outer: lines.filter((l) => l.startsWith("outer ")).map((l) => l.slice(6)),
  };
}

describe("entrypoint mail passthrough (spec 026)", () => {
  it("maps every documented variable into its rauthy name", () => {
    const { inner } = runSmtp({
      ENRAHITU_SMTP_URL: "smtp.example.com",
      ENRAHITU_SMTP_PORT: "587",
      ENRAHITU_SMTP_USERNAME: "postmaster",
      ENRAHITU_SMTP_PASSWORD: "hunter2",
      ENRAHITU_SMTP_FROM: "Example Society <noreply@example.org>",
      ENRAHITU_SMTP_STARTTLS_ONLY: "true",
      ENRAHITU_SMTP_CONNECT_RETRIES: "3",
      ENRAHITU_SMTP_DANGER_INSECURE: "false",
    });
    expect(inner).toEqual([
      "SMTP_CONNECT_RETRIES=3",
      "SMTP_DANGER_INSECURE=false",
      "SMTP_FROM=Example Society <noreply@example.org>",
      "SMTP_PASSWORD=hunter2",
      "SMTP_PORT=587",
      "SMTP_STARTTLS_ONLY=true",
      "SMTP_URL=smtp.example.com",
      "SMTP_USERNAME=postmaster",
    ]);
  });

  it("leaves an unset variable absent rather than empty", () => {
    // rauthy distinguishes the two for several of these, so exporting an unset
    // variable as "" would configure a blank relay rather than no relay.
    const { inner } = runSmtp({ ENRAHITU_SMTP_URL: "smtp.example.com" });
    expect(inner).toEqual(["SMTP_URL=smtp.example.com"]);
    expect(inner.some((l) => l.startsWith("SMTP_PASSWORD"))).toBe(false);
  });

  it("keeps mail credentials out of the app process environment", () => {
    // The subshell is the only reason this holds, and it is the reason the
    // mapping is a function called there rather than exports at top level.
    const { outer } = runSmtp({
      ENRAHITU_SMTP_URL: "smtp.example.com",
      ENRAHITU_SMTP_PASSWORD: "hunter2",
    });
    expect(outer).toEqual([]);
  });

  it("removes an ambient SMTP_* that no operator asked for", () => {
    // Mapping alone does not achieve this. rauthy reads SMTP_URL from its
    // environment whether we set it or it was merely inherited, so without the
    // scrub an orchestrator exporting a shared SMTP_* for some other workload
    // silently configures this IdP's mail path.
    const { inner, outer } = runSmtp({ SMTP_URL: "relay.somebody-elses.example" });
    expect(inner).toEqual([]);
    expect(outer).toEqual([]);
  });

  it("lets ENRAHITU_SMTP_* win over an ambient value of the same setting", () => {
    const { inner } = runSmtp({
      SMTP_URL: "relay.somebody-elses.example",
      ENRAHITU_SMTP_URL: "smtp.example.com",
    });
    expect(inner).toEqual(["SMTP_URL=smtp.example.com"]);
  });

  it("scrubs before the app starts, and maps only inside the rauthy subshell", () => {
    // Placement is the whole guarantee: mapping at top level would hand the app
    // process the IdP's mail credentials.
    const script = readFileSync(ENTRYPOINT, "utf8");
    expect(script.match(/^\s*export_smtp_env$/gm) ?? []).toHaveLength(1);
    expect(script.match(/^scrub_smtp_env$/gm) ?? []).toHaveLength(1);
    expect(script.indexOf("\nscrub_smtp_env\n")).toBeLessThan(
      script.indexOf("  export_smtp_env\n"),
    );
  });
});
