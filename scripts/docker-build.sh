#!/usr/bin/env bash
# Build the enrahitu single-container image on the @statecrafting build
# toolchain: no `encore` CLI, and no Rust or cargo build anywhere in the
# pipeline. The Encore napi runtime and the hiqlite addon arrive as prebuilt,
# per-platform binaries from the published @statecrafting packages.
#
#   scripts/docker-build.sh [arch]     arch: arm64 (default) | amd64
#
# The image is assembled from a CLEAN git worktree of HEAD (so local secrets
# in .env, keys/, .data/ can never leak in) plus exactly four injected
# artifact kinds:
#   1. the target-arch hiqlite addon (@statecrafting/hiqlite-native-<triple>)
#   2. the built SPA (backend/web/dist)
#   3. production node_modules (npm ci --omit=dev + the linux libsql binding,
#      which npm on macOS never installs by itself)
#   4. the target-arch Encore napi runtime (encore-runtime.node, from
#      @statecrafting/toolchain-<triple>)
# The app bundle + metadata are produced INSIDE the worktree by the host's
# tsparser-encore (the @statecrafting/toolchain build driver), then
# docker/Dockerfile.base assembles the base image and docker/Dockerfile layers
# rauthy on top.
set -euo pipefail

ARCH="${1:-arm64}"
case "$ARCH" in
  arm64) NAPI_TRIPLE=linux-arm64-gnu; TC_TRIPLE=linux-arm64; LIBSQL_PKG=@libsql/linux-arm64-gnu; PLATFORM=linux/arm64; ELF_ARCH="ARM aarch64" ;;
  amd64) NAPI_TRIPLE=linux-x64-gnu; TC_TRIPLE=linux-x64; LIBSQL_PKG=@libsql/linux-x64-gnu; PLATFORM=linux/amd64; ELF_ARCH="x86-64" ;;
  *) echo "unsupported arch: $ARCH (arm64|amd64)" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The host's build driver: the tsparser resolved from the installed
# @statecrafting/toolchain platform package (npm ci must have run at the root).
# The TS parse runs on the build host, so this is the host arch, not the target.
TSPARSER="$(node -e "const{tsparserBin}=await import('@statecrafting/toolchain/resolve');process.stdout.write(tsparserBin({cwd:process.cwd()})||'')")"
if [ -z "$TSPARSER" ] || [ ! -x "$TSPARSER" ]; then
  echo "host tsparser not found via @statecrafting/toolchain; run npm ci first" >&2
  exit 1
fi

echo "==> building SPA"
npm run build:web
# The admin dashboard bundle (spec 023): built when the slot is present; a
# stamped app with admin = "off" carries neither the directory nor the script.
if [ -d frontend-admin ]; then
  echo "==> building admin dashboard"
  npm run build:web-admin
fi

WORKTREE="$(mktemp -d /tmp/enrahitu-image-XXXXXX)"
SCRATCH=""
cleanup() {
  git worktree remove --force "$WORKTREE" 2>/dev/null || true
  rm -rf "$WORKTREE"
  [ -n "$SCRATCH" ] && rm -rf "$SCRATCH"
}
trap cleanup EXIT

echo "==> clean worktree of HEAD at $WORKTREE"
git worktree add --detach "$WORKTREE" HEAD >/dev/null

echo "==> injecting SPA build"
rm -rf "$WORKTREE/backend/web/dist"
cp -R backend/web/dist "$WORKTREE/backend/web/dist"
if [ -d frontend-admin ] && [ -d backend/web/dist-admin ]; then
  rm -rf "$WORKTREE/backend/web/dist-admin"
  cp -R backend/web/dist-admin "$WORKTREE/backend/web/dist-admin"
fi
# The SPA source is not part of the image (backend/web/dist is prebuilt) and
# its devDependencies are not installed in the worktree; drop every frontend
# flavor directory (the template carries them all, spec 015) so the tsparser
# app walk never sees their unresolvable imports. The e2e/ suite (spec 017)
# is dropped for the same reason: its @playwright/test import is a devDep,
# absent under `npm ci --omit=dev`. Likewise the vitest configs since the
# published-toolchain repoint (spec 018): they import @statecrafting/toolchain
# (a devDep) to resolve the runtime for tests, and tests never run in the image.
rm -rf "$WORKTREE/frontend" "$WORKTREE/frontend-react" "$WORKTREE/frontend-admin" \
  "$WORKTREE/e2e" "$WORKTREE/vitest.config.ts" "$WORKTREE/vitest.setup.ts"

echo "==> production node_modules"
(cd "$WORKTREE" && npm ci --omit=dev --no-fund --no-audit >/dev/null)

echo "==> app bundle + metadata (@statecrafting/toolchain)"
(cd "$WORKTREE" && \
  ENCORE_TSPARSER_BIN="$TSPARSER" \
  ENCORE_TSBUNDLER_PATH="$ROOT/node_modules/@statecrafting/toolchain/lib/tsbundler.mjs" \
  node "$ROOT/node_modules/@statecrafting/toolchain/bin/build.mjs")
(cd "$WORKTREE" && node "$ROOT/node_modules/@statecrafting/toolchain/lib/augment-infra.mjs" \
  infra.config.json .encore/build/compile-result.json infra.config.docker.json)

# LAST tree mutations on purpose: fetch the TARGET-arch native binaries from the
# published @statecrafting packages (host-agnostic, so a macOS host cross-builds
# a linux image the same way CI's native linux host does) and inject them. Any
# later `npm install` in the worktree would prune the platform-mismatched
# binaries, so this runs after `npm ci`. Versions match what the app resolved.
echo "==> target-arch native binaries (@statecrafting)"
TC_VER="$(node -p "require('$ROOT/node_modules/@statecrafting/toolchain/package.json').version")"
HIQ_VER="$(cd "$WORKTREE" && node -p "require('@statecrafting/hiqlite-native/package.json').version")"
KER_VER="$(cd "$WORKTREE" && node -p "require('@statecrafting/kernel-native/package.json').version")"
SCRATCH="$(mktemp -d /tmp/enrahitu-bins-XXXXXX)"
(cd "$SCRATCH" && npm init -y >/dev/null 2>&1 && \
  npm install --no-save --force --no-fund --no-audit \
    "@statecrafting/toolchain-${TC_TRIPLE}@${TC_VER}" \
    "@statecrafting/hiqlite-native-${NAPI_TRIPLE}@${HIQ_VER}" \
    "@statecrafting/kernel-native-${NAPI_TRIPLE}@${KER_VER}" \
    "$LIBSQL_PKG" >/dev/null)

RUNTIME_NODE="$SCRATCH/node_modules/@statecrafting/toolchain-${TC_TRIPLE}/encore-runtime.node"
HIQ_DIR="$SCRATCH/node_modules/@statecrafting/hiqlite-native-${NAPI_TRIPLE}"
KER_DIR="$SCRATCH/node_modules/@statecrafting/kernel-native-${NAPI_TRIPLE}"
ADDON_NODE="$(ls "$HIQ_DIR"/*.node 2>/dev/null | head -1 || true)"
KERNEL_NODE="$(ls "$KER_DIR"/*.node 2>/dev/null | head -1 || true)"
if [ ! -f "$RUNTIME_NODE" ] || [ -z "$ADDON_NODE" ] || [ ! -f "$ADDON_NODE" ] \
  || [ -z "$KERNEL_NODE" ] || [ ! -f "$KERNEL_NODE" ]; then
  echo "missing target-arch native binary under $SCRATCH:" >&2
  echo "  runtime: $RUNTIME_NODE" >&2
  echo "  addon:   ${ADDON_NODE:-<none found>}" >&2
  echo "  kernel:  ${KERNEL_NODE:-<none found>}" >&2
  exit 1
fi

# A mismatched native artifact must fail the build, not the first request
# (spec 016): the addon and kernel .node files and the runtime must all be
# this arch's ELF.
for artifact in "$RUNTIME_NODE" "$ADDON_NODE" "$KERNEL_NODE"; do
  if ! file -b "$artifact" | grep -q "$ELF_ARCH"; then
    echo "arch mismatch: $artifact is not a $ELF_ARCH ELF (expected for $ARCH)" >&2
    file "$artifact" >&2 || true
    exit 1
  fi
done

echo "==> injecting native binaries"
cp "$RUNTIME_NODE" "$WORKTREE/docker/encore-runtime.node"
# The napi loader resolves the addon from its per-platform package; place the
# target-arch one in the worktree node_modules so the linux container finds it
# regardless of the build host.
mkdir -p "$WORKTREE/node_modules/@statecrafting"
rm -rf "$WORKTREE/node_modules/@statecrafting/hiqlite-native-${NAPI_TRIPLE}"
cp -R "$HIQ_DIR" "$WORKTREE/node_modules/@statecrafting/"
# The kernel addon (spec 021) resolves per-platform the same way.
rm -rf "$WORKTREE/node_modules/@statecrafting/kernel-native-${NAPI_TRIPLE}"
cp -R "$KER_DIR" "$WORKTREE/node_modules/@statecrafting/"
# The linux libsql binding, copied in for the same host-agnostic reason: inside
# a macOS tree npm classifies the platform-mismatched binding as a satisfied
# optional of libsql and silently no-ops, even with --force / --os / --cpu.
mkdir -p "$WORKTREE/node_modules/@libsql"
cp -R "$SCRATCH/node_modules/@libsql/." "$WORKTREE/node_modules/@libsql/"
BINDING_DIR="$WORKTREE/node_modules/@libsql/${LIBSQL_PKG#@libsql/}"
if [ ! -d "$BINDING_DIR" ]; then
  echo "linux libsql binding missing at $BINDING_DIR after injection" >&2
  exit 1
fi

echo "==> base image (app + runtime), $PLATFORM"
docker build --platform "$PLATFORM" -f "$WORKTREE/docker/Dockerfile.base" -t enrahitu-api:latest "$WORKTREE"

# The final entrypoint script hardcodes the app start command; fail loudly if
# the base image layout ever drifts from it.
EXPECTED='node --enable-source-maps /workspace/.encore/build/combined/combined/main.mjs'
ACTUAL="$(docker image inspect enrahitu-api:latest --format '{{join .Config.Entrypoint " "}}')"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "base image entrypoint changed:" >&2
  echo "  expected: $EXPECTED" >&2
  echo "  actual:   $ACTUAL" >&2
  echo "update docker/entrypoint.sh accordingly." >&2
  exit 1
fi

echo "==> final image (app + rauthy), $PLATFORM"
docker build --platform "$PLATFORM" -f docker/Dockerfile -t enrahitu:latest "$ROOT"

docker image inspect enrahitu:latest --format 'built enrahitu:latest ({{.Architecture}})'
