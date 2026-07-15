/**
 * Layered resolution of the two native toolchain binaries (spec 018 §3):
 * the Encore napi runtime (`encore-runtime.node`) and the TS parser/compiler
 * (`tsparser-encore`). Both resolve by the SAME documented order:
 *
 *   1. an explicit env override (ENCORE_RUNTIME_LIB / ENCORE_TSPARSER_BIN)
 *   2. the installed platform package under <cwd>/node_modules
 *      (@enrahitu/toolchain-<platform>, delivered by `npm ci` in a stamped app)
 *   3. the in-repo cargo build under <cwd>/vendor/encore (toolchain developers
 *      building from source in THIS repo; a stamped tree has no vendor/)
 *
 * The app root is the invoking process's cwd, never this module's location:
 * the drivers run as package bins over a consumer's tree.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Map a Node platform+arch pair to its toolchain platform-package name, or
 * null for an unsupported host (spec 018 matrix: darwin-arm64, linux-x64,
 * linux-arm64; Windows is out of scope).
 */
export function platformPackage(platform = process.platform, arch = process.arch) {
  const supported = {
    "darwin-arm64": "@enrahitu/toolchain-darwin-arm64",
    "linux-x64": "@enrahitu/toolchain-linux-x64",
    "linux-arm64": "@enrahitu/toolchain-linux-arm64",
  };
  return supported[`${platform}-${arch}`] ?? null;
}

/**
 * Resolve one toolchain binary to an absolute path, or null if no layer
 * provides it. Pure over its inputs so every branch is unit-testable.
 */
export function resolveBinary({
  binary,
  envOverride,
  cwd = process.cwd(),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (envOverride && existsSync(envOverride)) return envOverride;

  const pkg = platformPackage(platform, arch);
  if (pkg) {
    const fromNodeModules = join(cwd, "node_modules", ...pkg.split("/"), binary);
    if (existsSync(fromNodeModules)) return fromNodeModules;
  }

  const fromVendor = join(cwd, "vendor/encore/target/release", binary);
  if (existsSync(fromVendor)) return fromVendor;

  return null;
}

/** Resolve the Encore napi runtime (`encore-runtime.node`). */
export function runtimeLib({ envOverride, ...rest } = {}) {
  return resolveBinary({
    binary: "encore-runtime.node",
    envOverride: envOverride ?? process.env.ENCORE_RUNTIME_LIB,
    ...rest,
  });
}

/** Resolve the TS parser/compiler binary (`tsparser-encore`). */
export function tsparserBin({ envOverride, ...rest } = {}) {
  return resolveBinary({
    binary: "tsparser-encore",
    envOverride: envOverride ?? process.env.ENCORE_TSPARSER_BIN,
    ...rest,
  });
}
