---
id: "008-vendored-encore-toolchain"
title: "Vendored Encore toolchain: rust core + js runtime via napi-rs, no CLI"
status: approved
created: "2026-07-14"
implementation: complete
depends_on:
  - "001-enrahitu-architecture"
amends:
  - "007-single-container-packaging"
establishes:
  - { kind: directory, path: "vendor/encore/" }
  - { kind: directory, path: "scripts/encore/" }
  - "infra.config.dev.json"
  - "docker/Dockerfile.base"
summary: >
  The enrahitu fork point: the Encore runtime is vendored (upstream
  encoredev/encore @ v1.57.9) and driven directly via napi-rs, removing the
  encore CLI from every flow. vendor/encore/ carries the rust core
  (runtimes/core), the napi bindings crate (runtimes/js, built into
  encore-runtime.node), the TS parser/compiler (tsparser, the
  tsparser-encore binary), miniredis (a core path dependency), and the
  published encore.dev JS runtime package (the app's encore.dev dep is a
  file: link into it). scripts/encore/ drives the toolchain: build, dev run,
  esbuild bundling, infra-config augmentation, and the linux cross-build.
---

# 008: Vendored Encore toolchain

## 1. Purpose

Encore.ts apps normally depend on the `encore` CLI (a Go binary) for dev
runs, typechecking, and image builds. The CLI is orchestration: the real
machinery is Rust (the runtime core and the TS parser) plus the encore.dev
JS runtime, glued to Node via napi-rs, the same pattern as the hiqlite
addon (spec 002). enrahitu vendors that machinery and drives it directly,
so the toolchain is fully source-pinned inside the repo: no CLI install, no
version skew, no dependence on Encore's release pipeline.

## 2. Territory

- `vendor/encore/`: pruned upstream workspace @ v1.57.9 (members:
  runtimes/core, runtimes/js, tsparser, miniredis; plus proto/ for
  prost codegen). `[patch.crates-io]` keeps Encore's swc and rust-postgres
  forks. `runtimes/js/encore.dev` is the published 1.57.9 npm artifact
  (sources + built dist/), linked into node_modules via the root
  package.json `file:` dependency. The release profile is relaxed to thin
  LTO for tolerable local builds.
- `scripts/encore/build.mjs`: drives `tsparser-encore` over its framed
  stdin/stdout protocol (prepare, parse, compile), emitting
  `.encore/build/meta` (the app metadata protobuf) and the combined bundle.
- `scripts/encore/tsbundler.mjs`: drop-in esbuild shim for Encore's
  `tsbundler-encore` Go wrapper, injected via `ENCORE_TSBUNDLER_PATH`.
- `scripts/encore/dev.mjs`: the `encore run` replacement: build, augment the
  dev infra config, run the bundle under plain node with
  `ENCORE_RUNTIME_LIB` / `ENCORE_APP_META_PATH` / `ENCORE_INFRA_CONFIG_PATH`
  / `PORT`.
- `scripts/encore/augment-infra.mjs`: fills `hosted_services` /
  `hosted_gateways` / `cors` into a base infra config from the compile
  result, as `encore build docker` did for the image config.
- `scripts/encore/link-runtime.mjs`: exposes the cargo-built cdylib as
  `encore-runtime.node` and prunes CMake's `*.ts` dependency-tracking files
  from the target trees (the tsparser app walk would parse them).
- `scripts/encore/build-runtime-linux.sh`: containerized (rust:1-bookworm)
  cross-build of the napi runtime for the image.
- `infra.config.dev.json`: dev-mode base infra config (no secrets section,
  so `secret()` yields empty and the keys/ file fallbacks apply, matching
  CLI dev behavior).
- `docker/Dockerfile.base`: assembles the app base image (the
  `encore build docker` replacement) with the same layout: /workspace tree,
  /encore/meta, /encore/infra.config.json, /encore/runtimes/js/
  encore-runtime.node, and the identical entrypoint command.

## 3. Behavior

- **CLI-flow replacements**: `encore run` becomes `npm run dev`;
  `encore check` becomes `tsc --noEmit`; `encore build docker` becomes
  `scripts/docker-build.sh` (amending spec 007: same clean-worktree
  contract, one more injected artifact: the linux encore-runtime.node; the
  SPA source is dropped from the worktree since its devDependencies are not
  installed there).
- **Version discipline**: everything is pinned to upstream v1.57.9: the
  vendored sources, the published encore.dev package, and the
  `ENCORE_VERSION` stamp baked into the runtime at cargo build time (the JS
  runtime asserts it at load).
- **Runtime configuration**: self-host mode end to end. The runtime reads
  the infra config (`ENCORE_INFRA_CONFIG_PATH`) and app metadata
  (`ENCORE_APP_META_PATH`, or the /encore/meta autodetect path in the
  image); a config without `hosted_services`/`hosted_gateways` hosts
  nothing, hence the augmentation step.
- **Tests** (vitest) resolve `ENCORE_RUNTIME_LIB` from the vendored build
  instead of a CLI installation, and receive `ENCORE_APP_META_PATH` +
  `ENCORE_INFRA_CONFIG_PATH` (built by `npm run build:app`, augmented
  like the dev runner) so the runtime's test mode short-circuits its
  `encore test --prepare` CLI fallback. Amended 2026-07-14: the original
  wiring set only `ENCORE_RUNTIME_LIB`, which silently leaned on a
  locally installed encore CLI for runtime-touching tests; the first
  CLI-less CI runner exposed the gap (dead vitest workers). Without a
  prior `build:app`, pure tests still run and runtime-touching tests
  require the CLI daemon.

## 4. Out of scope

- Tracking upstream Encore releases: bumping the vendor is a manual,
  reviewed re-copy at a new tag (a future spec may add tooling).
- Publishing the vendored crates or the toolchain scripts for reuse outside
  this repo.
- Dev-mode hot reload (`encore run`'s watcher); `npm run dev` rebuilds on
  invocation. A watch mode is future work.
- Windows hosts.
