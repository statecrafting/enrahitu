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
x86-64 nodes, so amd64 is a launch requirement for statecraft's fleet
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
  The arch-independent JS loader (`addon/index.js`, `index.d.ts`) that
  docker-build.sh injects is still emitted by the host `npm run
  build:addon`; the bookworm cross-build only replaces the `.node`.
- Smoke: `docker run --platform linux/amd64` (under emulation locally,
  natively in CI) boots, `/health` and `/hiq/health` return 200, and
  first-boot secret provisioning (spec 007) completes.
- Optional but preferred: an `image.yml` workflow on
  `workflow_dispatch` + weekly schedule building both arches on a
  ubuntu runner (amd64 native, arm64 cross or matrix) so drift is
  caught without gating every push on a long image build.
- **Publish.** On `release` or `workflow_dispatch` (never on a PR, so a
  fork cannot push), each arch job pushes its smoked image to
  `ghcr.io/<owner>/enrahitu:<sha>-<arch>`, and a `manifest` job stitches
  the two into the pullable multi-arch tags (`:<sha>`, `:latest`, and the
  release tag) with `docker buildx imagetools`, so `docker pull` resolves
  per host arch. GHCR auth is the workflow `GITHUB_TOKEN` (`packages:
  write`). This is the registry publishing that §5 deferred until the
  fleet needed it: the fleet control plane (statecraft spec 006) now
  places EnRaHiTu containers on x86-64 nodes and must pull this image.

## 4. Acceptance

- Both `scripts/docker-build.sh arm64` and `scripts/docker-build.sh amd64`
  succeed from a clean checkout on this Mac, and each image passes the
  smoke above under its platform.
- The amd64 image runs on a real x86-64 host (fleet node or CI runner),
  same smoke.
- The published multi-arch image is pullable from GHCR
  (`docker pull ghcr.io/statecrafting/enrahitu:<tag>`) and its amd64
  manifest boots on an x86-64 host with the smoke above.
- Spine gates green; specs 007/008 amended where behavior moved.

## Status (2026-07-16)

Reopened `in-progress`. §5 originally deferred registry publishing until fleet
integration arrived; it has. statecraft spec 006's fleet E2E needs a pullable
amd64 enrahitu image, and this workflow was the only place that builds one (it
built and smoked but never pushed). `image.yml` now pushes each arch to
`ghcr.io/statecrafting/enrahitu` and assembles a multi-arch manifest on
`release`/`workflow_dispatch`. The build + smoke acceptance already held; the
new publish acceptance is now verified: the `image` workflow ran (2026-07-16),
built and smoked both arches on native runners, and pushed them, so
`ghcr.io/statecrafting/enrahitu:latest` resolves as a multi-arch manifest list
carrying linux/amd64 (digest `sha256:0be2dca8...`) and linux/arm64, pulled under
auth. The package is private, so the fleet supplies GHCR credentials through its
image-pull secret (statecraft spec 006, `FLEET_IMAGE_PULL_SECRET`). Back to
`complete`.

## 5. Out of scope

- Automatic publish on every push (kept to `release`/`workflow_dispatch` +
  the weekly drift build, so a long image build never gates a push).
- musl/static builds; glibc images match the current base.

## Amendment (2026-07-23): the admin bundle's deps in the image workflow

Spec 023's `frontend-admin/` broke the image build silently (the
cron/dispatch-only failure mode spec 007's 2026-07-22 amendment
records): `docker-build.sh` runs `npm run build:web-admin` when the
directory is present, but `image.yml` installed only the root and
`frontend/` dependency trees, so the dashboard's vite/tsc build died
on missing packages; PR #27 patched `verify.yml` and `e2e.yml` and
missed this workflow. `image.yml` now installs `frontend-admin/`
alongside `frontend/` and adds its lockfile to the npm cache key.
Surfaced by the 007-nonroot-image validation dispatch, the first
image run after PR #27 merged.
