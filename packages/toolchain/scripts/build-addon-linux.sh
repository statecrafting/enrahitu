#!/usr/bin/env bash
# Cross-build the hiqlite-native addon for the container image, inside
# rust:1-bookworm so its .node links against the same glibc (2.36) as the
# node:24-slim runtime image.
#
#   packages/toolchain/scripts/build-addon-linux.sh [arch]   arch: arm64 (default) | amd64
#
# Building the addon NATIVELY on a newer runner (ubuntu-24.04 is glibc 2.39)
# produces a .node that requires GLIBC_2.38 and fails to load in the bookworm
# image ("version `GLIBC_2.38' not found"), crashing the app at startup. This
# matches build-runtime-linux.sh, which already builds the runtime .so in the
# same bookworm environment.
#
# The addon is a napi-rs cdylib whose build.rs runs napi_build::setup(), so a
# plain `cargo build --release` emits a working N-API module. napi CLI's build
# would only rename the cdylib to the platform .node and regenerate
# index.js/index.d.ts, which are already committed. So we cargo-build in
# bookworm and rename the cdylib, no node/napi toolchain in the container.
set -euo pipefail

ARCH="${1:-arm64}"
case "$ARCH" in
  arm64) PLATFORM=linux/arm64; NAPI_TRIPLE=linux-arm64-gnu ;;
  amd64) PLATFORM=linux/amd64; NAPI_TRIPLE=linux-x64-gnu ;;
  *) echo "unsupported arch: $ARCH (arm64|amd64)" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

docker run --rm --platform "$PLATFORM" \
  -e NAPI_TRIPLE="$NAPI_TRIPLE" \
  -v "$ROOT/addon":/addon \
  -v enrahitu-cargo-registry:/usr/local/cargo/registry \
  -v enrahitu-cargo-git:/usr/local/cargo/git \
  -w /addon rust:1-bookworm bash -c '
    set -euo pipefail
    apt-get update -qq >/dev/null
    apt-get install -y -qq protobuf-compiler cmake >/dev/null
    CARGO_TARGET_DIR=/addon/target-linux cargo build --release
    # Rename the cdylib to the napi platform .node HERE, as root inside the
    # container, so a non-root host user (a Linux CI runner) is not blocked by
    # container-root ownership of the target dir.
    cp "/addon/target-linux/release/libhiqlite_native.so" \
       "/addon/hiqlite-native.${NAPI_TRIPLE}.node"
  '

NODE="$ROOT/addon/hiqlite-native.${NAPI_TRIPLE}.node"
if [ ! -f "$NODE" ]; then
  echo "expected $NODE after the container build" >&2
  exit 1
fi
echo "built $NODE ($ARCH)"
