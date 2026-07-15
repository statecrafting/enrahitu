---
id: "016-amd64-image"
title: "linux/amd64 image support (multi-arch packaging)"
status: approved
created: "2026-07-14"
implementation: complete
depends_on:
  - "007-single-container-packaging"
  - "008-vendored-encore-toolchain"
summary: >
  The single-container image (spec 007) currently ships arm64 only,
  matching the development Macs. Fleet targets (Hetzner x86 nodes, most
  customer clusters) need linux/amd64. This spec extends the
  cross-build pipeline (scripts/encore/build-runtime-linux.sh and
  scripts/docker-build.sh already take an arch argument) to produce and
  verify an amd64 image, and wires an optional CI path so the
  capability cannot silently rot. Owed item carried from the enrahi
  phase-7 close-out.
establishes:
  - ".github/workflows/image.yml"
---

# 016: linux/amd64 image

## 1. Purpose

An EnRaHiTu app's deployable unit is one image + one volume. A template
whose image only exists for arm64 cannot be placed on the fleet's
x86-64 nodes, so amd64 is a launch requirement for stagecraft's fleet
milestone (M3), not a nice-to-have.

## 2. Territory

`.github/workflows/image.yml` (this spec's own surface): the image-build
workflow described in §3. The cross-build driver
`build-runtime-linux.sh` already takes the arch argument and relocated to
`packages/toolchain/scripts/` under spec 018, so it needed no change. The
one behavioral change lands in `scripts/docker-build.sh` (owned by spec
007, its §Behavior amended): the `[arch]` argument now drives
`docker build --platform linux/<arch>` (previously it only selected the
injected artifacts, silently building a host-arch image), and the
injected addon `.node` + runtime `.so` are ELF-arch-checked so a mismatch
fails the build.

## 3. Behavior

- `scripts/docker-build.sh amd64` produces a runnable linux/amd64 image
  on an arm64 Mac (cross-compile the runtime and addon for
  x86_64-unknown-linux-gnu; document required toolchain targets:
  `rustup target add x86_64-unknown-linux-gnu` plus the linker the
  script expects; buildx for the image assembly).
- The addon (hiqlite-native) and the vendored runtime
  (encore-runtime.node) must both be arch-correct in the image; a
  mismatched .node file must fail the build, not the first request
  (docker-build.sh ELF-checks both). They must also match the image's
  glibc: both are cross-built in `rust:1-bookworm`
  (`build-addon-linux.sh`, `build-runtime-linux.sh`) so they link against
  bookworm's glibc, not the newer glibc of the CI runner. A native runner
  build (glibc 2.39) requires `GLIBC_2.38`, which the `node:24-slim`
  (bookworm, glibc 2.36) image lacks, and the app crashes on first load.
- Smoke: `docker run --platform linux/amd64` (under emulation locally,
  natively in CI) boots, `/health` and `/hiq/health` return 200, and
  first-boot secret provisioning (spec 007) completes.
- Optional but preferred: an `image.yml` workflow on
  `workflow_dispatch` + weekly schedule building both arches on a
  ubuntu runner (amd64 native, arm64 cross or matrix) so drift is
  caught without gating every push on a long image build.

## 4. Acceptance

- Both `scripts/docker-build.sh arm64` and `scripts/docker-build.sh amd64`
  succeed from a clean checkout on this Mac, and each image passes the
  smoke above under its platform.
- The amd64 image runs on a real x86-64 host (fleet node or CI runner),
  same smoke.
- Spine gates green; specs 007/008 amended where behavior moved.

## 5. Out of scope

- A public registry publishing pipeline (arrives with fleet/factory
  integration, stagecraft side).
- musl/static builds; glibc images match the current base.
