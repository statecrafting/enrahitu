# CLAUDE.md: enrahitu

## Project Overview

enrahitu (**EnRaHiTu**: **En**core.ts + **ra**uthy + **hi**qlite +
**Tu**rso) is a self-contained application substrate with the Encore
toolchain vendored: the rust runtime core, the TS parser/compiler, and
the encore.dev JS runtime live in `vendor/encore/` and are driven
directly via napi-rs; the `encore` CLI is not used anywhere (spec 008).
One Docker image + one volume = a complete authenticated application,
zero managed-infrastructure dependencies. It is also the template
chassis stamped by the Statecraft factory (spec 009 defines the
versioned template contract; spec 010 tracks template-encore
absorption). Lineage: formerly `enrahi` / `enrahi-kit`.
The architecture thesis lives in `specs/001-enrahitu-architecture/spec.md`;
`docs/ARCHITECTURE.md` is the human overview.

## Repository Structure

The two-directory layout (spec 019): every Encore.ts concern lives under
`backend/`, the SPA under `frontend/`; everything else at the root is
contract, packaging, governance, or chassis toolchain source.

```
specs/       Feature specs (000-019), the authoritative design record
standards/   spec-spine constitution, contract, templates
template.toml  The versioned template contract the Statecraft factory reads (spec 009)
backend/     The Encore.ts app (spec 019):
  hiq/         Encore service over the addon (spec 002)
  core/        CoreLedger decorator data layer on libSQL/Turso (spec 003)
  auth/        Auth service: JWT cookies, refresh rotation, drivers (spec 004)
  lib/         Shared security library: jwt, cookies, csrf, rate-limit (spec 004)
  idp/         Same-origin /auth/* passthrough proxy onto rauthy (spec 005)
  web/         Encore static service serving the built SPA (spec 006)
  health/      Liveness + decorator canary (spec 001)
frontend/    Vue 3 + Vite SPA source, builds into backend/web/dist (spec 006)
addon/       Rust napi-rs cdylib: in-process hiqlite; chassis source, root-level (spec 002)
docker/      Single-container packaging: Dockerfiles, entrypoint, first-boot (specs 007/008)
scripts/     docker-build.sh (007), generate-keys.ts (004), sync-dev-rauthy-secret.mjs (005)
packages/    @enrahitu/toolchain (relocated build drivers + binary resolver) and its per-platform binary carrier packages (spec 018)
vendor/encore/   Encore @ v1.57.9: rust core, napi bindings, tsparser, encore.dev; source of record the toolchain packages build from (specs 008/018)
.derived/    Compiler output (committed shards; build-meta.json gitignored)
```

## Governance

This repo is governed by [spec-spine](https://github.com/statecrafting/spec-spine)
(`spec-spine.toml`, owned by spec 000):

- **Specs are the source of truth.** Every substantive change is bound to a
  spec under `specs/NNN-slug/spec.md`; owned paths and their owning spec move
  together (`spec-spine couple` enforces this at PR time; waiver keyword
  `Spec-Drift-Waiver:` in the PR body).
- **Manifest linkage.** `package.json` carries `"spec-spine": { "spec": ... }`
  (root → 001, `addon/` → 002, `frontend/` → 006); `addon/Cargo.toml` carries
  `[package.metadata.spec-spine]`.
- **Governed reads.** Read `.derived/**` only through `spec-spine` subcommands
  (`registry list/show/status-report`, `index check/render/orphans`); never
  ad-hoc `jq`/`python` parsers (`.claude/rules/governed-artifact-reads.md`).
- **After editing any `specs/*/spec.md`**: run `spec-spine compile && spec-spine index`
  and commit the regenerated `.derived/` shards with the spec edit.

## Build Commands

```bash
npm run build:addon    # build the hiqlite-native addon (Rust, ~2 min, required once)
npm run build:runtime  # build the vendored Encore toolchain (Rust, required once)
npm install
npm run dev            # build + run on :4000 under plain node (no encore CLI)
npm run build:app      # parse + bundle only (.encore/build/)
npm run typecheck      # tsc --noEmit
npm test               # vitest (uses the vendored encore-runtime.node)
npm run dev:idp        # dev rauthy via docker compose (spec 005)
npm run build:web      # build the SPA into backend/web/dist
packages/toolchain/scripts/build-runtime-linux.sh arm64   # cross-build the runtime for the image
scripts/docker-build.sh arm64                 # the full single-container image (specs 007/008)

spec-spine compile    # specs -> .derived/spec-registry/by-spec/
spec-spine index      # code linkage -> .derived/codebase-index/
spec-spine lint       # corpus conformance
spec-spine couple --base origin/main --head HEAD   # the PR coupling gate
```

Requires Node >= 24, Rust (stable), protoc, docker, and `spec-spine`
(`cargo install spec-spine-cli`; or run `/setup`). The Encore CLI is NOT
required (and not used): spec 008.

## Key Conventions

- **No Encore `SQLDatabase` anywhere.** Durable state is CoreLedger's job
  (spec 003). `encore run` must never want Docker Postgres.
- **Single-package repo, no npm workspaces** (spec 001 key decision 1);
  `addon/` and `frontend/` have standalone manifests.
- **Stage-3 TS decorators only**; no `experimentalDecorators`.
- **rauthy is reached through the app's origin** (`/auth/*` proxy, spec 005);
  never expose or hardcode a second origin for the IdP.
- **Secrets are first-boot-provisioned in the container** (spec 007); local
  dev secrets (`.env`, `keys/`) are gitignored and must never enter an image
  or a commit.
