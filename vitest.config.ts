import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { transformWithEsbuild, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

import { augmentInfraConfig } from "@statecrafting/toolchain/augment-infra";
import { runtimeLib as resolveRuntimeLib } from "@statecrafting/toolchain/resolve";

/**
 * Vitest 4 transforms TS via oxc (rolldown-vite), which cannot lower stage-3
 * decorators yet; esbuild (>= 0.21) can. Pre-transform only the files that
 * actually use decorators, targeting es2022 so the syntax is fully lowered
 * before Node sees it. Encore's own transformer handles decorators natively
 * at runtime; this shim is test-only.
 */
function stage3Decorators(): Plugin {
  return {
    name: "enrahitu:stage3-decorators",
    enforce: "pre",
    async transform(code, id) {
      if (!id.endsWith(".ts") || !/^\s*@[A-Za-z_$]/m.test(code)) return null;
      return transformWithEsbuild(code, id, { target: "es2022" });
    },
  };
}

/**
 * Unit tests import Encore primitives (APIError, middleware), so the napi
 * binding needs ENCORE_RUNTIME_LIB. There is no vendor/ tree; the toolchain's
 * own resolver locates the runtime in the installed platform package
 * (@statecrafting/toolchain-<platform>), matching how enrahitu-dev/enrahitu-build
 * find it. Falls back to undefined when the platform package is absent, so pure
 * tests still run.
 */
function encoreRuntimeLib(): string | undefined {
  if (process.env.ENCORE_RUNTIME_LIB) return process.env.ENCORE_RUNTIME_LIB;
  return resolveRuntimeLib({ cwd: dirname(fileURLToPath(import.meta.url)) }) ?? undefined;
}

const runtimeLib = encoreRuntimeLib();

/**
 * Test-mode equivalent of `encore test --prepare`, without the encore CLI
 * (spec 008). The runtime's enable_test_mode() short-circuits when
 * ENCORE_APP_META_PATH is set; otherwise it shells out to `encore`, which
 * the kit does not require (and CI does not have). When the app has been
 * built (npm run build:app), point every test worker at the compiled app
 * meta and the augmented infra config, exactly as the enrahitu-dev runner
 * (@statecrafting/toolchain) does for `encore run`. Without a prior build this returns {} so pure
 * tests still run; runtime-touching tests then need the CLI daemon.
 */
function encoreTestEnv(): Record<string, string> {
  const repoRoot = dirname(fileURLToPath(import.meta.url));
  const metaPath = resolve(repoRoot, ".encore/build/meta");
  const compileResult = resolve(repoRoot, ".encore/build/compile-result.json");
  if (!existsSync(metaPath) || !existsSync(compileResult)) return {};
  const infraPath = resolve(repoRoot, ".encore/build/infra.config.test.json");
  augmentInfraConfig(resolve(repoRoot, "infra.config.dev.json"), compileResult, infraPath);
  return { ENCORE_APP_META_PATH: metaPath, ENCORE_INFRA_CONFIG_PATH: infraPath };
}

export default defineConfig({
  plugins: [stage3Decorators()],
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.ts"],
    exclude: [
      "node_modules/**",
      "frontend/**",
      "frontend-react/**",
      "encore.gen/**",
      // The Playwright login e2e (spec 017) runs under its own runner, never vitest.
      "e2e/**",
    ],
    env: {
      ...(runtimeLib ? { ENCORE_RUNTIME_LIB: runtimeLib } : {}),
      ...encoreTestEnv(),
    },
  },
});
