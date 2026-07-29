#!/usr/bin/env node
/**
 * The infra-config generator (spec 033 §3.4).
 *
 * Encore takes its infrastructure from `infra.config.json`. This repo has
 * carried two hand-maintained copies (selfhost and dev) that must agree on
 * everything except the handful of fields that distinguish them, and spec 030
 * adds a third with a `pubsub` block. Three files that must agree, with nothing
 * making them agree, is a drift generator: the spec 017 login failures that
 * only ever reproduced on CI were this shape of problem.
 *
 * So the topologies are declared once, here, and the files are derived. The
 * toolchain's `augmentInfraConfig` is the precedent: it already merges the
 * compile step's hosted services and gateways into the base at build time.
 * This does the same job one level earlier, for the parts that are authored
 * rather than compiled.
 *
 *   node scripts/gen-infra-config.mjs           # write every topology
 *   node scripts/gen-infra-config.mjs --check   # fail if a committed file drifted
 *
 * `--check` is the gate. It runs in CI, so a hand-edit to a generated file is
 * caught at the PR rather than discovered at boot in an environment nobody
 * develops in.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCHEMA = "https://encore.dev/schemas/infra.schema.json";

/**
 * Secrets are `$env` references, never values: the runtime resolves them from
 * the process environment, which is how the container binds material that
 * first-boot generated into the volume (spec 007) without it ever entering a
 * file that could be committed or baked into an image.
 */
const APP_SECRETS = [
  "JWT_PRIVATE_KEY",
  "JWT_PUBLIC_KEY",
  "JWT_REFRESH_PRIVATE_KEY",
  "JWT_REFRESH_PUBLIC_KEY",
  "RAUTHY_CLIENT_SECRET",
];

function envRefs(names) {
  return Object.fromEntries(names.map((n) => [n, { $env: n }]));
}

/**
 * The topologies. Each is (file, metadata, whether secrets are declared).
 *
 * `sql_servers` is deliberately absent from all of them, and that absence is
 * load bearing rather than an oversight: the block exists to serve Encore's
 * `SQLDatabase`, and adopting that primitive would put Encore in charge of
 * durable state and its migrations, displacing the state layer this substrate
 * owns (spec 001 §4.2 decision 2). Whether the slot is ever populated for
 * unbounded overflow is an open decision resolved by spec 032, not a default.
 */
export const TOPOLOGIES = {
  /**
   * dev: the docker N=1 development topology. No `secrets` block on purpose.
   * With none declared, `secret()` yields "" and `backend/lib/secrets.ts` falls
   * back to the PEM files in the keys directory, which is what lets a developer
   * run without provisioning anything.
   */
  dev: {
    file: "infra.config.dev.json",
    metadata: {
      app_id: "enrahitu",
      env_name: "local",
      env_type: "development",
      cloud: "local",
      base_url: "http://localhost:4000",
    },
    secrets: false,
  },

  /**
   * selfhost: the packaged single container (spec 007). Secrets are declared as
   * `$env` refs, which the entrypoint binds from the material first-boot wrote
   * into the volume.
   */
  selfhost: {
    file: "infra.config.json",
    metadata: {
      app_id: "enrahitu",
      env_name: "selfhost",
      env_type: "production",
      cloud: "local",
      base_url: "http://localhost:8080",
    },
    secrets: true,
  },
};

/**
 * Collapse a lone `{ "$env": "NAME" }` onto one line.
 *
 * Purely cosmetic, and deliberate: it makes the generator reproduce the
 * previously hand-written files byte for byte, so adopting it is a diff of
 * zero rather than a reformat that has to be read to be trusted. A secrets
 * block is a list of names and reads better one per line anyway.
 */
function inlineEnvRefs(json) {
  return json.replace(/\{\n\s+"\$env": ("[^"]+")\n\s+\}/g, "{ \"$env\": $1 }");
}

export function render(topology) {
  const spec = TOPOLOGIES[topology];
  if (!spec) throw new Error(`unknown topology: ${topology}`);
  const doc = { $schema: SCHEMA, metadata: spec.metadata };
  if (spec.secrets) doc.secrets = envRefs(APP_SECRETS);
  return `${inlineEnvRefs(JSON.stringify(doc, null, 2))}\n`;
}

export function generate({ check = false } = {}) {
  const drifted = [];
  const written = [];
  for (const [name, spec] of Object.entries(TOPOLOGIES)) {
    const path = join(repoRoot, spec.file);
    const want = render(name);
    const have = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (have === want) continue;
    if (check) drifted.push(spec.file);
    else {
      writeFileSync(path, want);
      written.push(spec.file);
    }
  }
  return { drifted, written };
}

const invokedDirectly =
  import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;

if (invokedDirectly) {
  const check = process.argv.includes("--check");
  const { drifted, written } = generate({ check });
  if (check) {
    if (drifted.length > 0) {
      console.error(
        `[gen-infra-config] committed config drifted from its source: ${drifted.join(", ")}`,
      );
      console.error("Run `npm run gen:infra` and commit the result.");
      console.error("These files are generated; edit scripts/gen-infra-config.mjs instead.");
      process.exit(1);
    }
    console.log(`[gen-infra-config] ${Object.keys(TOPOLOGIES).length} topolog(ies) fresh`);
  } else {
    console.log(
      written.length > 0
        ? `[gen-infra-config] wrote ${written.join(", ")}`
        : "[gen-infra-config] already up to date",
    );
  }
}
