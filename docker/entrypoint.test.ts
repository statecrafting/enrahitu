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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("holds each mail surface in exactly one process (spec 037 §3.1)", () => {
    // Two surfaces means two holders, and that has to be true in BOTH
    // directions or it is one surface with extra prefixes. rauthy must not
    // inherit the application's relay credentials, and the application must not
    // keep the IdP's once rauthy's subshell has captured them.
    const script = readFileSync(ENTRYPOINT, "utf8");
    const harness = join(dir, "surfaces.sh");
    writeFileSync(
      harness,
      [
        "#!/bin/bash",
        "set -euo pipefail",
        bashFunction(script, "export_smtp_env"),
        // rauthy's subshell, in the order the entrypoint runs it.
        '( export_smtp_env; for n in ${!ENRAHITU_MAIL_*}; do unset "$n"; done;',
        '  env | grep -E "^(SMTP_|ENRAHITU_MAIL_)" | sort | sed "s/^/rauthy /" ) || true',
        // Then the app process, after the IdP's surface is dropped.
        'for n in ${!ENRAHITU_SMTP_*}; do unset "$n"; done',
        'env | grep -E "^(ENRAHITU_SMTP_|ENRAHITU_MAIL_)" | sort | sed "s/^/app /" || true',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const out = spawnSync("bash", [harness], {
      env: {
        ...process.env,
        ENRAHITU_SMTP_URL: "idp-relay.example.org",
        ENRAHITU_SMTP_PASSWORD: "idp-secret",
        ENRAHITU_MAIL_HOST: "app-relay.example.org",
        ENRAHITU_MAIL_PASSWORD: "app-secret",
      },
      encoding: "utf8",
    });
    const lines = out.stdout.trim().split("\n").filter(Boolean);
    const rauthy = lines.filter((l) => l.startsWith("rauthy ")).map((l) => l.slice(7));
    const app = lines.filter((l) => l.startsWith("app ")).map((l) => l.slice(4));

    // rauthy holds its own relay, mapped, and none of the application's.
    expect(rauthy).toContain("SMTP_URL=idp-relay.example.org");
    expect(rauthy).toContain("SMTP_PASSWORD=idp-secret");
    expect(rauthy.some((l) => l.startsWith("ENRAHITU_MAIL_"))).toBe(false);

    // The application holds its own and none of the IdP's.
    expect(app).toContain("ENRAHITU_MAIL_HOST=app-relay.example.org");
    expect(app).toContain("ENRAHITU_MAIL_PASSWORD=app-secret");
    expect(app.some((l) => l.startsWith("ENRAHITU_SMTP_"))).toBe(false);
  });

  it("drops each surface at the right point in the script", () => {
    // Placement is the guarantee. Unsetting ENRAHITU_SMTP_* before the rauthy
    // subshell would leave the IdP with no relay at all.
    const script = readFileSync(ENTRYPOINT, "utf8");
    expect(script.indexOf("  export_smtp_env\n")).toBeLessThan(
      script.indexOf("for name in ${!ENRAHITU_SMTP_*}"),
    );
    expect(script.indexOf("for name in ${!ENRAHITU_MAIL_*}")).toBeLessThan(
      script.indexOf("for name in ${!ENRAHITU_SMTP_*}"),
    );
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

/**
 * Per-store restore scoping (spec 027 §3.3, its §4 item 9).
 *
 * `HQL_BACKUP_RESTORE` is hiqlite's own variable and this container runs two
 * independent hiqlite nodes, so one ambient value naming one file is read by
 * both: rauthy's identity store and the app's resource store. Whichever node it
 * was not meant for either refuses the file or, worse, accepts it. That was
 * latent only while the app's store held nothing worth restoring.
 *
 * The failure this guards is INHERITANCE rather than logic, which is why these
 * assertions are made against the environment two subshells actually see rather
 * than against the script's text. A mapping that reads correctly and leaks is
 * exactly the bug.
 */
function runRestore(env: Record<string, string>): { rauthy: string[]; app: string[] } {
  const script = readFileSync(ENTRYPOINT, "utf8");
  const harness = join(dir, "restore.sh");
  const report = (label: string) =>
    `env | grep -E "^(HQL_BACKUP_RESTORE|ENRAHITU_RESTORE_)" | sort | sed "s/^/${label} /"`;
  writeFileSync(
    harness,
    [
      "#!/bin/bash",
      "set -euo pipefail",
      bashFunction(script, "export_restore_env"),
      // The scrub the entrypoint performs after sourcing restore.env, so an
      // inherited value cannot reach either node.
      "unset HQL_BACKUP_RESTORE",
      // Both supervised processes, each in its own subshell, in script order.
      `( export_restore_env ENRAHITU_RESTORE_RAUTHY "rauthy"; ${report("rauthy")} ) || true`,
      `( export_restore_env ENRAHITU_RESTORE_APP "app"; ${report("app")} ) || true`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const out = spawnSync("bash", [harness], { env: { ...process.env, ...env }, encoding: "utf8" });
  const lines = out.stdout.trim().split("\n").filter(Boolean);
  return {
    rauthy: lines.filter((l) => l.startsWith("rauthy ")).map((l) => l.slice(7)),
    app: lines.filter((l) => l.startsWith("app ")).map((l) => l.slice(4)),
  };
}

describe("entrypoint restore scoping (spec 027 §3.3)", () => {
  it("offers each hiqlite node its own snapshot and never the other's", () => {
    const { rauthy, app } = runRestore({
      ENRAHITU_RESTORE_RAUTHY: "file:/data/restore/rauthy.sqlite",
      ENRAHITU_RESTORE_APP: "file:/data/restore/app.sqlite",
    });
    expect(rauthy).toEqual(["HQL_BACKUP_RESTORE=file:/data/restore/rauthy.sqlite"]);
    expect(app).toEqual(["HQL_BACKUP_RESTORE=file:/data/restore/app.sqlite"]);
  });

  it("leaves neither prefixed variable visible in either process", () => {
    // The mapping is only half of it. A node that can SEE the other store's
    // request is one config change away from acting on it.
    const { rauthy, app } = runRestore({
      ENRAHITU_RESTORE_RAUTHY: "file:/data/restore/rauthy.sqlite",
      ENRAHITU_RESTORE_APP: "file:/data/restore/app.sqlite",
    });
    expect(rauthy.some((l) => l.startsWith("ENRAHITU_RESTORE_"))).toBe(false);
    expect(app.some((l) => l.startsWith("ENRAHITU_RESTORE_"))).toBe(false);
  });

  it("restores one store without arming the other", () => {
    const { rauthy, app } = runRestore({
      ENRAHITU_RESTORE_APP: "file:/data/restore/app.sqlite",
    });
    expect(rauthy).toEqual([]);
    expect(app).toEqual(["HQL_BACKUP_RESTORE=file:/data/restore/app.sqlite"]);
  });

  it("lets an inherited HQL_BACKUP_RESTORE reach neither node", () => {
    // The variable is hiqlite's own name, so an orchestrator exporting it for
    // some other workload would otherwise arm a restore nobody asked for, on a
    // node nobody chose.
    const { rauthy, app } = runRestore({ HQL_BACKUP_RESTORE: "file:/somebody/elses.sqlite" });
    expect(rauthy).toEqual([]);
    expect(app).toEqual([]);
  });

  it("scrubs the ambient value before either subshell maps its own", () => {
    // Placement is the guarantee: scrubbing after the subshells would scrub
    // nothing, and scrubbing before first-boot would cost the log line that
    // tells the operator their variable was ignored.
    const script = readFileSync(ENTRYPOINT, "utf8");
    expect(script.match(/^unset HQL_BACKUP_RESTORE$/gm) ?? []).toHaveLength(1);
    expect(script.indexOf("node /enrahitu/first-boot.mjs")).toBeLessThan(
      script.indexOf("\nunset HQL_BACKUP_RESTORE\n"),
    );
    expect(script.indexOf("\nunset HQL_BACKUP_RESTORE\n")).toBeLessThan(
      script.indexOf("  export_restore_env ENRAHITU_RESTORE_RAUTHY"),
    );
  });

  it("runs the app in a subshell so its decision cannot reach rauthy's", () => {
    // The app used to start at top level, which is why this is asserted: a
    // top-level export would be visible to everything started afterwards.
    const script = readFileSync(ENTRYPOINT, "utf8");
    expect(script).toContain("  export_restore_env ENRAHITU_RESTORE_APP");
    // `exec` is what keeps $APP_PID the process the traps signal.
    expect(script).toContain("exec node --enable-source-maps");
    expect(script).toContain("exec node /workspace/scripts/dev-watch.mjs");
  });
});

/**
 * The app's hiqlite material reaches the app process (spec 007, amendment
 * 2026-08-06; spec 027 §4 item 5).
 *
 * secrets.env is SOURCED and its lines carry no `export`, so every name in it
 * lands as an unexported shell variable. A subshell inherits those, which makes
 * the mistake invisible when read: `exec` then replaces the subshell with the
 * app, and a process environment carries only EXPORTED names. So the app's node
 * received none of it, and provisioning an encryption key without this would
 * have provisioned a key the app never sees.
 *
 * The assertions therefore run against the environment an EXEC-ED child
 * actually has, not against the subshell's variables and not against the
 * script's text. A subshell that reads correctly and delivers nothing is
 * precisely the bug.
 */
function runHiq(secretsEnv: string): { rauthy: string[]; app: string[] } {
  const script = readFileSync(ENTRYPOINT, "utf8");
  const secrets = join(dir, "secrets.env");
  writeFileSync(secrets, secretsEnv, { mode: 0o600 });

  const harness = join(dir, "hiq.sh");
  writeFileSync(
    harness,
    [
      "#!/bin/bash",
      "set -euo pipefail",
      bashFunction(script, "export_hiq_env"),
      // Sourced exactly as the entrypoint sources it.
      `. "${secrets}"`,
      // rauthy's subshell exports its own material and never calls this, so an
      // exec-ed rauthy must see none of the app's keys.
      '( exec env ) | grep "^ENRAHITU_HIQ_" | sort | sed "s/^/rauthy /" || true',
      // The app's subshell. `exec env` is `exec node` with a printable payload.
      '( export_hiq_env; exec env ) | grep "^ENRAHITU_HIQ_" | sort | sed "s/^/app /" || true',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // A deliberately minimal environment: an ENRAHITU_HIQ_* inherited from the
  // developer's shell would make this pass without the export doing anything.
  const out = spawnSync("bash", [harness], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
  const lines = (out.stdout ?? "").trim().split("\n").filter(Boolean);
  return {
    rauthy: lines.filter((l) => l.startsWith("rauthy ")).map((l) => l.slice(7)),
    app: lines.filter((l) => l.startsWith("app ")).map((l) => l.slice(4)),
  };
}

const SECRETS_ENV = [
  "RAUTHY_ENC_KEYS='enrahitura1234/aGVsbG8='",
  "ENRAHITU_HIQ_ENC_KEYS='enrahituapp567/d29ybGQ='",
  "ENRAHITU_HIQ_ENC_KEY_ACTIVE='enrahituapp567'",
  "ENRAHITU_HIQ_SECRET_RAFT='raftsecret'",
  "ENRAHITU_HIQ_SECRET_API='apisecret'",
  "",
].join("\n");

describe("entrypoint hiqlite key delivery (spec 007)", () => {
  it("puts every provisioned name in the exec-ed app's environment", () => {
    const { app } = runHiq(SECRETS_ENV);
    expect(app).toEqual([
      "ENRAHITU_HIQ_ENC_KEYS=enrahituapp567/d29ybGQ=",
      "ENRAHITU_HIQ_ENC_KEY_ACTIVE=enrahituapp567",
      "ENRAHITU_HIQ_SECRET_API=apisecret",
      "ENRAHITU_HIQ_SECRET_RAFT=raftsecret",
    ]);
  });

  it("delivers nothing to a process that does not export it", () => {
    // The regression itself: sourcing put these names in the entrypoint's shell
    // and the raft/API secrets were provisioned for two releases without ever
    // reaching the node they were generated for.
    const { rauthy } = runHiq(SECRETS_ENV);
    expect(rauthy).toEqual([]);
  });

  it("keeps the resource store's keys out of rauthy's process", () => {
    // The other direction of spec 037 §3.1's two-holders rule. rauthy's subshell
    // forks before this function is ever called, and the call sits inside the
    // app's subshell rather than at top level so that stays true.
    const script = readFileSync(ENTRYPOINT, "utf8");
    expect(script.match(/^\s*export_hiq_env$/gm) ?? []).toHaveLength(1);
    expect(script.indexOf("exec ./rauthy serve")).toBeLessThan(
      script.indexOf("  export_hiq_env"),
    );
  });

  it("still boots when the volume's secrets.env predates the encryption key", () => {
    // `export NAME` on an unset name leaves it ABSENT rather than present and
    // empty, so a legacy volume falls back to the addon's key instead of
    // handing the node a blank one. first-boot.mjs names that case out loud.
    const { app } = runHiq(
      ["ENRAHITU_HIQ_SECRET_RAFT='raftsecret'", "ENRAHITU_HIQ_SECRET_API='apisecret'", ""].join("\n"),
    );
    expect(app).toEqual(["ENRAHITU_HIQ_SECRET_API=apisecret", "ENRAHITU_HIQ_SECRET_RAFT=raftsecret"]);
    expect(app.some((l) => l.startsWith("ENRAHITU_HIQ_ENC_KEY"))).toBe(false);
  });
});

/**
 * The pre-flight call (spec 027 §3.5, and the second half of its §4 item 8).
 *
 * "The entrypoint calls it and fails closed" is a claim about this script, so it
 * is executed here rather than described: the real prologue, up to and including
 * the verb call, runs against a stub `node` that exits with a chosen status. The
 * verb's own conditions are covered one at a time in
 * `scripts/ops/preflight.test.ts`; what is proven here is that a nonzero verdict
 * stops the boot instead of being logged and stepped over.
 */
const PREFLIGHT_CALL = "node /workspace/scripts/ops/preflight.mjs";

function prologue(script: string): string {
  const idx = script.indexOf(PREFLIGHT_CALL);
  if (idx === -1) throw new Error("entrypoint.sh no longer calls the pre-flight verb");
  return script.slice(0, idx + PREFLIGHT_CALL.length);
}

function runPrologue(verdict: number): { code: number; stdout: string; invoked: string[] } {
  const script = readFileSync(ENTRYPOINT, "utf8");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const args = join(dir, "args");
  writeFileSync(
    join(bin, "node"),
    ["#!/bin/sh", `echo "$@" >> "${args}"`, `exit ${verdict}`, ""].join("\n"),
    { mode: 0o755 },
  );
  const harness = join(dir, "prologue.sh");
  writeFileSync(harness, [prologue(script), "echo continued", ""].join("\n"), { mode: 0o755 });
  const out = spawnSync("bash", [harness], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });
  return {
    code: out.status ?? -1,
    stdout: out.stdout ?? "",
    invoked: existsSync(args) ? readFileSync(args, "utf8").trim().split("\n").filter(Boolean) : [],
  };
}

describe("entrypoint pre-flight (spec 027)", () => {
  it("refuses to continue when the verb refuses", () => {
    const { code, stdout, invoked } = runPrologue(1);
    expect(invoked).toEqual(["/workspace/scripts/ops/preflight.mjs"]);
    expect(stdout).not.toContain("continued");
    expect(code).toBe(1);
  });

  it("continues when the verb is satisfied", () => {
    const { code, stdout } = runPrologue(0);
    expect(stdout).toContain("continued");
    expect(code).toBe(0);
  });

  it("runs before first-boot and before either supervised process", () => {
    // Ordering is the guarantee. A pre-flight that ran after first-boot would
    // validate a volume that had already been written to, and one that ran after
    // rauthy would report the ports it had itself just taken.
    const script = readFileSync(ENTRYPOINT, "utf8");
    const at = (needle: string) => script.indexOf(needle);
    expect(at(PREFLIGHT_CALL)).toBeGreaterThan(-1);
    expect(at(PREFLIGHT_CALL)).toBeLessThan(at("node /enrahitu/first-boot.mjs"));
    expect(at(PREFLIGHT_CALL)).toBeLessThan(at("exec ./rauthy serve"));
  });

  it("keeps one implementation of the required-env contract, not two", () => {
    // The bash loop this replaced (spec 007) was a second implementation of a
    // fleet-facing check, and the untestable one of the pair.
    const script = readFileSync(ENTRYPOINT, "utf8");
    expect(script).not.toContain("ENRAHITU_REQUIRED_ENV");
  });
});
