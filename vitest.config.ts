import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { transformWithEsbuild, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

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
 * binding needs ENCORE_RUNTIME_LIB. In enrahitu it is the vendored,
 * cargo-built runtime (npm run build:runtime), not the Encore CLI's copy.
 * Falls back to undefined when unbuilt, so pure tests still run.
 */
function encoreRuntimeLib(): string | undefined {
  if (process.env.ENCORE_RUNTIME_LIB) return process.env.ENCORE_RUNTIME_LIB;
  const vendored = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "vendor/encore/target/release/encore-runtime.node",
  );
  return existsSync(vendored) ? vendored : undefined;
}

const runtimeLib = encoreRuntimeLib();

export default defineConfig({
  plugins: [stage3Decorators()],
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "addon/**", "webapp/**", "encore.gen/**"],
    env: runtimeLib ? { ENCORE_RUNTIME_LIB: runtimeLib } : {},
  },
});
