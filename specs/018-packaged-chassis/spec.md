---
id: "018-packaged-chassis"
title: "Package-distributed chassis: the toolchain leaves the tree"
status: approved
created: "2026-07-14"
implementation: complete
depends_on:
  - "008-vendored-encore-toolchain"
  - "009-template-contract"
amends:
  - "002-in-process-hiqlite"
  - "008-vendored-encore-toolchain"
  - "009-template-contract"
establishes:
  - { kind: directory, path: "packages/" }
  - { kind: file, path: ".github/workflows/publish.yml" }
summary: >
  The heavy invariants leave the template tree and become versioned npm
  packages with prebuilt binaries: @enrahitu/toolchain (the vendored
  Encore build drivers + encore-runtime.node + tsparser, per-platform)
  and @enrahitu/hiqlite-native (the addon, prebuilt). The template
  drops from ~780 tracked files to a surface a developer can read in
  one sitting, and a chassis upgrade becomes a devDependency bump
  instead of a tree re-import. Decided 2026-07-14 to land BEFORE
  statecraft's app-shell import (statecraft spec 002), so the first
  template consumer never duplicates the fat tree. The build contract
  is unchanged where it matters: a stamped app still builds with
  npm + cargo-free installs and NO proprietary tool; the Statecraft
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
  build-runtime-linux, build-addon-linux), exposed as bin entries (`enrahitu-dev`,
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
- **The vendored source leaves the stamped tree via `export-ignore`.**
  `.gitattributes` marks the heavy `vendor/encore` build-source subtrees
  (`tsparser`, `miniredis`, `proto`, `runtimes/core`,
  `runtimes/js/{src,build.rs}`, and the workspace Cargo manifests)
  `export-ignore`, mirroring the `.dockerignore` exclusions. `git archive`
  (what the Statecraft factory uses to export a stamp, statecraft spec
  005) honours it, so a stamp carries the packaged toolchain, not its
  source: the export drops from 861 to 441 tracked files. The
  `runtimes/js/encore.dev` JS runtime (195 files) is deliberately kept,
  because a stamped app resolves it through the `node_modules` symlink
  (the same reason `.dockerignore` keeps it). This realizes the "vendor
  leaves the stamped tree" claim of §1/§2 for the archive path; slimming
  `addon/` Rust source toward the full "no vendor/, no addon/ source"
  target (§4) is a follow-on on the same mechanism.
- **Platform matrix**: darwin-arm64, linux-x64, linux-arm64. This is
  the same matrix spec 016 (amd64 image) needs; implement the shared
  cross-build once, in the publish workflow, and let 016's image build
  consume the linux artifacts. The linux cross-build
  (`build-runtime-linux`) deletes CMake's stray `.ts` dependency files
  inside the build container, as root, so a non-root host (a Linux CI
  runner) is never blocked by container-root ownership when it consumes
  the target dir; macOS Docker Desktop remapped ownership and hid this.
- **Supervisor: explicit non-goal.** Upstream Encore's self-hosted
  images use a Rust supervisor binary to orchestrate multiple service
  processes and the gateway. EnRaHiTu builds ONE combined bundle
  (all services + gateway in a single node process; spec 007/008), so
  the only second process is rauthy, owned by docker/entrypoint.sh.
  The supervisor is therefore deliberately absent from the vendor tree
  and from @enrahitu/toolchain. It becomes relevant only if a future
  spec splits services into separate processes; that spec would add it
  consciously, not by default.
  - **What is NOT dropped: the reverse proxy.** The real gateway
    (pingora-based router, auth handshake, CORS, healthz) lives in
    `runtimes/core/src/api/gateway/` and stays vendored and active:
    in the combined bundle it listens on the exposed port in-process
    and proxies to the process's own API listener over loopback
    (`own_api_address`). Verified against upstream v1.57.9: the
    supervisor crate is only a process foreman (spawn children with
    env_clear, restart policy, SIGINT/SIGTERM shutdown) plus a
    single-upstream port forwarder with a healthz fan-out; every
    piece of routing intelligence is in the runtime-core gateway,
    which we keep. Rust multithreading is likewise unaffected: the
    runtime core builds a multi-thread tokio runtime inside whatever
    process loads encore-runtime.node (`runtimes/core/src/lib.rs`),
    supervisor or not.
  - **Pub/sub is orthogonal to the supervisor.** Delivery is
    broker-backed via the infra config (no broker is declared today
    and no service uses topics); the gateway's push-subscription
    proxying exists to route push callbacks between service processes
    in the split topology and is trivial in the combined one. Adding
    pub/sub later is an infra-config + broker decision, not a
    supervisor decision.
  - **Event-loop pressure ladder** (mitigations before any process
    split): the runtime config carries a per-service worker_threads
    knob that runs JS handlers on Node worker threads (merged to the
    minimum across co-hosted services in a combined process; a value
    of 1 disables); CPU-heavy work can move to app-level worker
    threads; and if per-service isolation is ever truly needed, the
    shape is per-service images behind service discovery, which does
    not use the supervisor either. Whether worker_threads is
    reachable through infra.config.json in combined mode must be
    verified at implementation time, not assumed.
- **Versioning**: toolchain package version tracks its own semver;
  the pinned upstream Encore version (v1.57.9) is recorded in the
  package README and a `--version` output. template.toml `[requires]`
  gains `toolchain = "<semver range>"` (minor contract bump per spec
  009 §3.1). Because these versions are independent of the template's
  release tag, the publish workflow is **idempotent** (amended
  2026-07-15): on a `v*` tag it publishes each `@enrahitu/*` package only
  when its current version is not already on npm, so a template-only
  release (no toolchain bump, e.g. the v0.2.0 feature release) is a clean
  no-op instead of a "cannot publish over previously published" failure.
- **Extraction stage (amended by spec 021, 2026-07-20)**: the toolchain
  gains the app-model producer: `bin/extract.mjs` (bin
  `enrahitu-extract`, with `--check` as the staleness gate) and
  `lib/extract/` (protobuf meta decode, manifest merge and lowering,
  verify, canonical hash and seal). To decode `.encore/build/meta` the
  package carries the meta/schema `.proto` files copied verbatim from
  `vendor/encore/proto` at the pinned upstream version (MPL-2.0 at file
  level, spec 008; the vendored tsparser itself is not patched). New
  runtime deps: `protobufjs` (decode), `ajv` (schema validation),
  `typescript` (the import-graph walk of the verify step), and
  `@statecrafting/kernel-native` (gate config hash and the
  genesisPayload sealing oracle). The extraction behavior contract is
  owned by spec 021; this spec owns only its packaging.

In-repo (satisfied in this source tree):

- Both packages published under the @enrahitu scope (done: all eight
  `@enrahitu/*` packages are live at v0.1.0; see §6).
- The publish workflow reproduces bit-compatible binaries from a tag, and
  is idempotent: a repeat `v*` tag whose `@enrahitu/*` versions are already
  on npm publishes nothing and succeeds (amended 2026-07-15).
- `git archive` of a template SHA excludes the vendored build-source
  (`vendor/encore/{tsparser,miniredis,proto,runtimes/core,runtimes/js/src,...}`)
  while keeping `runtimes/js/encore.dev`, so a stamp carries no toolchain
  build-source. Verifiable in-repo: the `vendor/` count in
  `git archive HEAD | tar -t` drops from 625 to 197.
- Spine gates green; spec 008 amended coherently.

Consumer-side (delegated, verified outside this repo): these require a
SLIMMED or stamped tree, which this source repo deliberately is not (it
keeps `vendor/` + `addon/` as the toolchain source of record, spec 019
§1). They are owned by the stamping path (the scaffold verb, spec 014)
and the first stamped consumer (statecraft spec 002), which run them on
their own CI against the published packages:

- From a clean clone of the SLIMMED tree (no vendor/, no addon/ source)
  on macOS arm64 and linux x64: `npm ci`, `npm run build:app`,
  `npm run typecheck`, `npm test` all green with binaries resolved from
  node_modules.
- `verify.yml` gets faster for consumers (no runtime cargo build; the
  cargo cache steps go away in the stamped tree).

## 5. Out of scope

- Moving app-owned code (services, webapp, docker packaging) into
  packages; that is spec 019's layout question and stays in-tree.
- The Statecraft CLI acquiring any build responsibility (the upgrade
  verb is statecraft-cli spec 006 and only orchestrates bumps).
- CoreLedger as a package (`@enrahitu/coreledger` is plausible later;
  it is user-extended app code today and stays in-tree).
- Windows binaries.

## 6. Status

**2026-07-14:** the in-repo structure landed and this repo stays green from
source (`implementation` was `in-progress` at that point).

**v0.1.0 published (2026-07-15).** All eight `@enrahitu/*` packages (the
`@enrahitu/toolchain` and `@enrahitu/hiqlite-native` meta packages plus their
three platform packages each) are live on npm at `0.1.0`, cut from the
`v0.1.0` tag by `publish.yml` with signed GitHub Actions provenance. Two
prerequisites had to hold for the provenance publish to pass: `NPM_TOKEN` must
be an npm automation token (a 2FA-gated token fails the CI publish with
`EOTP`), and every published manifest must carry a `repository` field matching
the GitHub source (a missing one fails with a 422 provenance mismatch). What
remains before `complete` is the clean-clone verification of the slimmed tree
resolving binaries from `node_modules` (below).

**2026-07-15 (export-ignore).** The "vendor leaves the stamped tree" claim
(§1/§2) is now realized on the archive path: `.gitattributes` marks the
`vendor/encore` build-source `export-ignore`, mirroring `.dockerignore`, so a
`git archive` stamp drops from 861 to 441 tracked files (`vendor/` 625 -> 197,
keeping the `encore.dev` JS runtime). Found via a dry-run of the Statecraft
factory's stamp export against a real target, which had been carrying all 625
vendor files into every stamp because no `export-ignore` existed. This closes
the `vendor/` half of the slimmed-tree target; the `addon/` Rust-source half
remains, on the same mechanism.

**Implementation decisions** (refine §2/§3, do not contradict them):

- **`file:` bootstrap.** This repo is the template *source*, so its root
  `devDependencies` reference `@enrahitu/toolchain` via `file:./packages/toolchain`
  (the same pattern as `@enrahitu/hiqlite-native": "file:./addon"`). A *stamped*
  app pins published exact versions instead. The platform packages are the
  toolchain's own `optionalDependencies` (with `os`/`cpu` guards); in this
  unpublished repo they 404 and are skipped, so the in-repo cargo fallback
  (resolution layer 3) is what serves local dev, exactly as intended.
- **cwd-based app root.** The drivers run as package bins and resolve the app
  root from `process.cwd()`, never their own file location. `packages/toolchain/lib/resolve.mjs`
  is the single layered resolver (env override, node_modules platform package,
  in-repo `vendor/encore/target/release`) with a unit test covering every branch.
- **Conditional runtime override.** `enrahitu-build` applies the
  `local_runtime_override` (pinning `encore.dev` to the vendored JS source)
  only when `vendor/encore/runtimes/js` exists; a stamped tree has no vendor/
  and uses the registry `encore.dev@1.57.9` (same pinned version).
- **hiqlite-native** keeps its package name and gains prebuild publish wiring:
  the napi loader already falls back to `@enrahitu/hiqlite-native-<triple>`
  platform packages, so the addon manifest drops `private` and the publish
  workflow builds the three platform packages and injects them as
  `optionalDependencies` into the published meta manifest. They are injected at
  publish time rather than committed to `addon/package.json`, because declaring
  them there re-resolves and churns `addon/package-lock.json` across platforms
  (the transitive emnapi optional tree) and breaks `npm ci` in `verify.yml`.
- **Provenance needs `repository`.** `publish.yml` publishes with
  `npm publish --provenance`, which rejects any package whose
  `repository.url` does not match the GitHub source recorded in the signed
  provenance bundle. Every published `@enrahitu/*` manifest therefore carries
  a `repository` field pointing at this repo; the addon platform packages
  inherit it from `addon/package.json` via `napi create-npm-dirs`.

**Landed:** `packages/toolchain/` (drivers as bins + resolver + README), the
three `@enrahitu/toolchain-<platform>` manifests, addon publish wiring,
`.github/workflows/publish.yml`, the root/vitest/docker rewiring to the bins,
`template.toml` contract bump, and the spec amendments (002/008/009). Local
gates green: `npm ci`, `npm run build:app`, `npm run typecheck`, `npm test`
(the toolchain resolves the in-repo runtime via resolution layer 3).

**Completed 2026-07-15.** Every in-repo acceptance item holds: the eight
`@enrahitu/*` packages are published (with the `@enrahitu` scope +
automation-`NPM_TOKEN` prerequisite met), the publish workflow reproduces
binaries from a tag, spine gates are green, and spec 008 is amended. The
residual clean-clone / `verify.yml`-faster checks are consumer-side and moved
to §4 "consumer-side (delegated)": they need a SLIMMED or stamped tree, which
this source repo is not (it keeps `vendor/` + `addon/` as the toolchain source
of record, spec 019 §1). The scaffold verb (spec 014) produces that tree and
the first stamped consumer (statecraft spec 002) runs `npm ci` + verify
against the published packages on its own CI. Marked complete on maintainer
direction; the delegated checks are tracked at their owners, not as blockers
here.
