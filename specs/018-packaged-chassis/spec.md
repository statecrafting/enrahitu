---
id: "018-packaged-chassis"
title: "Package-distributed chassis: the toolchain leaves the tree"
status: approved
created: "2026-07-14"
implementation: pending
depends_on:
  - "008-vendored-encore-toolchain"
  - "009-template-contract"
establishes:
  - { kind: directory, path: "packages/" }
summary: >
  The heavy invariants leave the template tree and become versioned npm
  packages with prebuilt binaries: @enrahitu/toolchain (the vendored
  Encore build drivers + encore-runtime.node + tsparser, per-platform)
  and @enrahitu/hiqlite-native (the addon, prebuilt). The template
  drops from ~780 tracked files to a surface a developer can read in
  one sitting, and a chassis upgrade becomes a devDependency bump
  instead of a tree re-import. Decided 2026-07-14 to land BEFORE
  stagecraft's app-shell import (stagecraft spec 002), so the first
  template consumer never duplicates the fat tree. The build contract
  is unchanged where it matters: a stamped app still builds with
  npm + cargo-free installs and NO proprietary tool; the Stagecraft
  CLI never becomes a build daemon.
---

# 018: Package-distributed chassis

## 1. Purpose

Of the template's ~780 tracked files, ~624 are `vendor/encore` and a
further chunk is `addon/` Rust source and `scripts/encore/` drivers.
None of that is code a template user reads, modifies, or owns; it is
distribution payload. Packages are the right rail for distribution:
versioned, pinned in a lockfile, upgraded by a one-line bump, and
publicly inspectable (Apache-2.0), so re-vendoring remains a
`npm pack` away for anyone who wants the old hermetic-tree shape.

## 2. Territory

- `packages/toolchain/`: the source of the published
  `@enrahitu/toolchain` package. Contents: the build drivers now in
  `scripts/encore/` (dev, build, tsbundler, link-runtime,
  build-runtime-linux), exposed as bin entries (`enrahitu-dev`,
  `enrahitu-build`); the vendored Encore Rust source stays in THIS
  repo (vendor/encore does not leave the repo, it leaves the *stamped
  tree*); platform binary subpackages
  `@enrahitu/toolchain-darwin-arm64`, `-linux-x64`, `-linux-arm64`
  carrying `encore-runtime.node` and the tsparser binary as
  optionalDependencies (the esbuild/napi-rs pattern).
- `packages/` is claimed as a directory; the addon's packaging edits
  amend spec 002's territory notes at implementation time
  (`@enrahitu/hiqlite-native` is already the addon's package name; it
  gains prebuilds and a publish pipeline rather than a rename).
- A publish workflow (`.github/workflows/publish.yml`) building the
  per-platform binaries and publishing on tag; its establishes edge is
  added here by amendment when it lands.
- Amends at implementation time: root package.json (devDependencies on
  the two packages, scripts calling the bins), `.gitignore`,
  `spec-spine.toml` package lists, and spec 008 (whose §Territory
  shrinks to the in-repo vendor + packages/toolchain; the "no encore
  CLI" behavior contract is unchanged).

## 3. Behavior

- **Template consumption**: a stamped app's package.json pins exact
  versions (`"@enrahitu/toolchain": "0.x.y"`); `npm ci` delivers the
  correct platform binary; `npm run dev` / `build:app` / `test` call
  the toolchain bins. ENCORE_RUNTIME_LIB resolves to the platform
  package's `encore-runtime.node` inside node_modules (vitest.config
  and the dev driver already treat the lib path as an input; the
  resolution order becomes: env override, node_modules platform
  package, in-repo cargo build for toolchain developers).
- **This repo remains buildable from source**: `npm run build:runtime`
  keeps working against vendor/encore for toolchain development; the
  packages are how CONSUMERS get binaries, not a replacement for the
  source of truth.
- **Platform matrix**: darwin-arm64, linux-x64, linux-arm64. This is
  the same matrix spec 016 (amd64 image) needs; implement the shared
  cross-build once, in the publish workflow, and let 016's image build
  consume the linux artifacts.
- **Supervisor: explicit non-goal.** Upstream Encore's self-hosted
  images use a Rust supervisor binary to orchestrate multiple service
  processes and the gateway. EnRaHiTu builds ONE combined bundle
  (all services + gateway in a single node process; spec 007/008), so
  the only second process is rauthy, owned by docker/entrypoint.sh.
  The supervisor is therefore deliberately absent from the vendor tree
  and from @enrahitu/toolchain. It becomes relevant only if a future
  spec splits services into separate processes; that spec would add it
  consciously, not by default.
- **Versioning**: toolchain package version tracks its own semver;
  the pinned upstream Encore version (v1.57.9) is recorded in the
  package README and a `--version` output. template.toml `[requires]`
  gains `toolchain = "<semver range>"` (minor contract bump per spec
  009 §3.1).

## 4. Acceptance

- From a clean clone of the SLIMMED template tree (no vendor/, no
  addon/ source) on both macOS arm64 and linux x64: `npm ci`,
  `npm run build:app`, `npm run typecheck`, `npm test` all green with
  binaries resolved from node_modules.
- `verify.yml` gets faster, not slower (no runtime cargo build in CI;
  the cargo cache steps go away for consumers).
- Both packages published under the @enrahitu scope (org-scoped npm;
  check scope availability first and record the outcome here).
- The publish workflow reproduces bit-compatible binaries from a tag.
- Spine gates green; spec 008 amended coherently.

## 5. Out of scope

- Moving app-owned code (services, webapp, docker packaging) into
  packages; that is spec 019's layout question and stays in-tree.
- The Stagecraft CLI acquiring any build responsibility (the upgrade
  verb is stagecraft-cli spec 006 and only orchestrates bumps).
- CoreLedger as a package (`@enrahitu/coreledger` is plausible later;
  it is user-extended app code today and stays in-tree).
- Windows binaries.
