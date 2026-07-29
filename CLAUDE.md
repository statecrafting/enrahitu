# CLAUDE.md: enrahitu

## Project Overview

enrahitu is a **membership and association management platform** for
non-profits and associations, shipped as a working application that
organizations extend rather than fork. It runs on the published
`@statecrafting/toolchain`: the Encore rust runtime core and TS
parser/compiler arrive as prebuilt per-platform binaries and are driven
directly via napi-rs; the `encore` CLI is not used anywhere (spec 008).
One container + one volume = a complete authenticated application.
It is also the template chassis stamped by the Statecraft factory
(spec 009 defines the versioned template contract; spec 010 tracks
template-encore absorption). Lineage: formerly `enrahi` / `enrahi-kit`.
The name is a proper noun; its former acronym expansion (Encore + rauthy
+ hiqlite + Turso) no longer describes the stack, because Turso is
benched (spec 001 §4.7).
The architecture thesis lives in `specs/001-enrahitu-architecture/spec.md`;
`docs/ARCHITECTURE.md` is the human overview.

## The 2026-07-27 pivot: read this before planning any change

The corpus is mid-pivot. Spec 001 §2 carries the rewrite record, §5.1
the phases, and **§5.2 a disposition table saying whether each spec is
current, rewritten, or rewrite-pending**. Check it before treating any
spec as truth.

What changed, in the four lines that most often mislead:

- **Layer ownership.** Encore.ts holds the edge (API, contracts,
  external seams) and is not the process supervisor. hiqlite is the
  state layer, not a cache. rauthy is the principal authority, not a
  login page. Application code holds intent and reconciliation.
- **Development is docker-only** in the target state. The old
  "`npm run dev` requires no infrastructure" invariant was wrong and is
  deleted; the *deployment* completeness invariant survives untouched.
  Phase 1b builds the compose loop; until it lands, the commands below
  are still the working ones.
- **N=1 is the primary mode.** One container, one volume, single Raft
  voter. State behavior at N=1 first; N=3 is the additional case.
- **The application ships and stays.** There is no prunable example
  slot and no template-you-fill-in.

Rewrite-pending specs (003, 004, 011, 024) still describe what is
actually built. Do not rewrite them ahead of the code; that is the
distinction between deleting a false invariant (phase 0, done) and
describing an unbuilt target (rides the implementing change).

## Repository Structure

The two-directory layout (spec 019): every Encore.ts concern lives under
`backend/`, the SPA under `frontend/`; everything else at the root is
contract, packaging, or governance. The build toolchain and the hiqlite
addon are npm dependencies (`@statecrafting/toolchain` + `hiqlite-native`),
no longer vendored in the tree.

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
  kernel/      Kernel-native adjudication + the Decision ledger (spec 021)
  obs/         /metrics, OTel tracer, bounded trace buffer (spec 022)
  admin/       Operator dashboard data plane + gated /admin serving (spec 023)
frontend/    Vue 3 + Vite SPA source, builds into backend/web/dist (spec 006)
frontend-admin/  React+RR7 operator dashboard, builds into backend/web/dist-admin (spec 023)
docker/      Single-container packaging: Dockerfiles, entrypoint, first-boot (specs 007/008)
scripts/     docker-build.sh (007), generate-keys.ts (004), sync-dev-rauthy-secret.mjs (005)
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
  (root → 001, `frontend/` → 006, `frontend-react/` → 015).
- **Governed reads.** Read `.derived/**` only through `spec-spine` subcommands
  (`registry list/show/status-report`, `index check/render/orphans`); never
  ad-hoc `jq`/`python` parsers (`.claude/rules/governed-artifact-reads.md`).
- **After editing any `specs/*/spec.md`**: run `spec-spine compile && spec-spine index`
  and commit the regenerated `.derived/` shards with the spec edit.

## Build Commands

```bash
npm install            # installs @statecrafting/toolchain + hiqlite-native (prebuilt binaries)
npm run dev            # build + run on :4000 under plain node (no encore CLI)
                       # PIVOT: replaced by the compose loop in phase 1b
npm run check:licenses # the AGPL boundary guard (spec 001 §4.7)
npm run build:app      # parse + bundle only (.encore/build/)
npm run extract:model  # build + write app-model.json (spec 020); check:model verifies it
npm run typecheck      # tsc --noEmit
npm test               # vitest (runtime resolved from the toolchain platform package)
npm run dev:idp        # dev rauthy via docker compose (spec 005)
npm run build:web      # build the SPA into backend/web/dist
npm run build:web-admin  # build the operator dashboard into backend/web/dist-admin
scripts/docker-build.sh arm64                 # the full single-container image (specs 007/008)

spec-spine compile    # specs -> .derived/spec-registry/by-spec/
spec-spine index      # code linkage -> .derived/codebase-index/
spec-spine lint       # corpus conformance
spec-spine couple --base origin/main --head HEAD   # the PR coupling gate
```

Requires Node >= 24, docker, and `spec-spine` (`cargo install spec-spine-cli`;
or run `/setup`). The toolchain and addon are prebuilt binaries, so no Rust,
cargo, or protoc is needed. The Encore CLI is NOT required (and not used):
spec 008.

## Key Conventions

- **No Encore `SQLDatabase` anywhere.** The ban is on the primitive:
  adopting it puts Encore in charge of durable state and its migrations,
  displacing the state layer this substrate owns. Unchanged by the pivot.
  The `sql_servers` *slot* is a separate, open question (spec 001 §4.2
  decision 2), unpopulated until the phase 1a interface contract resolves
  it. Durable state is CoreLedger's job today (spec 003) and hiqlite's
  after phase 2.
- **Single-package repo, no npm workspaces** (spec 001 key decision 1);
  `addon/` and `frontend/` have standalone manifests.
- **Stage-3 TS decorators only**; no `experimentalDecorators`.
- **rauthy is reached through the app's origin** (`/auth/*` proxy, spec 005);
  never expose or hardcode a second origin for the IdP.
- **Secrets are first-boot-provisioned in the container** (spec 007); local
  dev secrets (`.env`, `keys/`) are gitignored and must never enter an image
  or a commit.
