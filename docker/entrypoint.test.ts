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
import { spawn } from "node:child_process";
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
