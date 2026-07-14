#!/usr/bin/env bash
# Cross-build the vendored Encore napi runtime for the container image.
#
#   scripts/encore/build-runtime-linux.sh [arch]   arch: arm64 (default) | amd64
#
# Runs cargo inside rust:1-bookworm (same family as the addon's linux
# cross-build and the node:24-slim runtime image), writing to
# vendor/encore/target-linux/<triple>/release/libencore_js_runtime.so.
# Named docker volumes cache the cargo registry/git across runs.
set -euo pipefail

ARCH="${1:-arm64}"
case "$ARCH" in
  arm64) PLATFORM=linux/arm64; TRIPLE=aarch64-unknown-linux-gnu ;;
  amd64) PLATFORM=linux/amd64; TRIPLE=x86_64-unknown-linux-gnu ;;
  *) echo "unsupported arch: $ARCH (arm64|amd64)" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

docker run --rm --platform "$PLATFORM" \
  -v "$ROOT/vendor/encore":/src \
  -v enrahitu-cargo-registry:/usr/local/cargo/registry \
  -v enrahitu-cargo-git:/usr/local/cargo/git \
  -w /src rust:1-bookworm bash -c "
    set -euo pipefail
    apt-get update -qq >/dev/null
    apt-get install -y -qq protobuf-compiler cmake >/dev/null
    ENCORE_VERSION=v1.57.9 CARGO_TARGET_DIR=/src/target-linux \
      cargo build --release -p encore-js-runtime
  "

SO="$ROOT/vendor/encore/target-linux/release/libencore_js_runtime.so"
if [ ! -f "$SO" ]; then
  echo "expected $SO after the container build" >&2
  exit 1
fi
# The tsparser app walk chokes on CMake's *.ts dependency-tracking files.
find "$ROOT/vendor/encore/target-linux" -name "*.ts" -type f -delete
echo "built $SO ($ARCH)"
