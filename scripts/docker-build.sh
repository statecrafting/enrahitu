#!/usr/bin/env bash
# Build the enrahitu single-container image with the vendored Encore
# toolchain: no `encore` CLI anywhere in the pipeline.
#
#   scripts/docker-build.sh [arch]     arch: arm64 (default) | amd64
#
# The image is assembled from a CLEAN git worktree of HEAD (so local secrets
# in .env, keys/, .data/ can never leak in) plus exactly four injected
# artifact kinds:
#   1. the cross-built hiqlite-native addon (.node + napi-generated loader)
#   2. the built SPA (backend/web/dist)
#   3. production node_modules (npm ci --omit=dev + the linux libsql binding,
#      which npm on macOS never installs by itself)
#   4. the cross-built Encore napi runtime (encore-runtime.node, from
#      packages/toolchain/scripts/build-runtime-linux.sh)
# The app bundle + metadata are produced INSIDE the worktree by the host
# tsparser-encore (packages/toolchain/bin/build.mjs), then docker/Dockerfile.base
# assembles the base image and docker/Dockerfile layers rauthy on top.
set -euo pipefail

ARCH="${1:-arm64}"
case "$ARCH" in
  arm64) NAPI_TRIPLE=linux-arm64-gnu; LIBSQL_PKG=@libsql/linux-arm64-gnu ;;
  amd64) NAPI_TRIPLE=linux-x64-gnu; LIBSQL_PKG=@libsql/linux-x64-gnu ;;
  *) echo "unsupported arch: $ARCH (arm64|amd64)" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ADDON_NODE="addon/hiqlite-native.${NAPI_TRIPLE}.node"
for required in "$ADDON_NODE" addon/index.js addon/index.d.ts; do
  if [ ! -f "$required" ]; then
    echo "missing $required" >&2
    echo "build the addon first: npm run build:addon (host) + the linux cross-build" >&2
    exit 1
  fi
done

TSPARSER="$ROOT/vendor/encore/target/release/tsparser-encore"
if [ ! -x "$TSPARSER" ]; then
  echo "missing $TSPARSER; run: npm run build:runtime" >&2
  exit 1
fi

RUNTIME_SO="$ROOT/vendor/encore/target-linux/release/libencore_js_runtime.so"
if [ ! -f "$RUNTIME_SO" ]; then
  echo "missing $RUNTIME_SO" >&2
  echo "cross-build the Encore runtime first: packages/toolchain/scripts/build-runtime-linux.sh $ARCH" >&2
  exit 1
fi

echo "==> building SPA"
npm run build:web

WORKTREE="$(mktemp -d /tmp/enrahitu-image-XXXXXX)"
cleanup() {
  git worktree remove --force "$WORKTREE" 2>/dev/null || true
  rm -rf "$WORKTREE"
}
trap cleanup EXIT

echo "==> clean worktree of HEAD at $WORKTREE"
git worktree add --detach "$WORKTREE" HEAD >/dev/null

echo "==> injecting build artifacts"
cp "$ADDON_NODE" addon/index.js addon/index.d.ts "$WORKTREE/addon/"
rm -rf "$WORKTREE/backend/web/dist"
cp -R backend/web/dist "$WORKTREE/backend/web/dist"
cp "$RUNTIME_SO" "$WORKTREE/docker/encore-runtime.node"
# The SPA source is not part of the image (backend/web/dist is prebuilt) and
# its devDependencies are not installed in the worktree; drop it so the
# tsparser app walk never sees its unresolvable imports.
rm -rf "$WORKTREE/frontend"

echo "==> production node_modules"
(cd "$WORKTREE" && npm ci --omit=dev --no-fund --no-audit >/dev/null)

echo "==> app bundle + metadata (vendored toolchain)"
(cd "$WORKTREE" && \
  ENCORE_TSPARSER_BIN="$TSPARSER" \
  ENCORE_TSBUNDLER_PATH="$ROOT/packages/toolchain/lib/tsbundler.mjs" \
  node packages/toolchain/bin/build.mjs)
(cd "$WORKTREE" && node packages/toolchain/lib/augment-infra.mjs \
  infra.config.json .encore/build/compile-result.json infra.config.docker.json)

# LAST tree mutation on purpose: the linux binding is extraneous to the lock,
# and any later `npm install` (e.g. the toolchain's prepare step deciding the
# tree needs a refresh) would prune it. Installed via a scratch package and
# copied in: inside the real tree npm classifies the platform-mismatched
# binding as a satisfied optional of libsql and silently no-ops, even with
# --force / --os / --cpu.
echo "==> linux libsql binding"
LIBSQL_TMP="$(mktemp -d /tmp/enrahitu-libsql-XXXXXX)"
(cd "$LIBSQL_TMP" && npm init -y >/dev/null 2>&1 && \
  npm install --no-save --force --no-fund --no-audit "$LIBSQL_PKG" >/dev/null)
mkdir -p "$WORKTREE/node_modules/@libsql"
cp -R "$LIBSQL_TMP/node_modules/@libsql/." "$WORKTREE/node_modules/@libsql/"
rm -rf "$LIBSQL_TMP"
BINDING_DIR="$WORKTREE/node_modules/@libsql/${LIBSQL_PKG#@libsql/}"
if [ ! -d "$BINDING_DIR" ]; then
  echo "linux libsql binding missing at $BINDING_DIR after injection" >&2
  exit 1
fi

echo "==> base image (app + vendored runtime)"
docker build -f "$WORKTREE/docker/Dockerfile.base" -t enrahitu-api:latest "$WORKTREE"

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

echo "==> final image (app + rauthy)"
docker build -f docker/Dockerfile -t enrahitu:latest "$ROOT"

docker image inspect enrahitu:latest --format 'built enrahitu:latest ({{.Architecture}})'
