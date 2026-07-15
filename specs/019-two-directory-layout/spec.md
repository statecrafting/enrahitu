---
id: "019-two-directory-layout"
title: "Template layout: frontend/ + backend/, nothing else to explain"
status: approved
created: "2026-07-14"
implementation: complete
depends_on:
  - "018-packaged-chassis"
establishes:
  - { kind: directory, path: "backend/" }
  - { kind: directory, path: "frontend/" }
summary: >
  After spec 018 sheds the toolchain payload, the remaining tree is
  restructured into two directories a developer understands at first
  glance: frontend/ (the SPA, one directory per flavor lifecycle) and
  backend/ (every Encore.ts service plus the shared lib and CoreLedger).
  Decided 2026-07-14, chosen over client/apis and app/services because
  frontend/backend is the pair with zero ambiguity. All Encore.ts
  concerns co-locate under backend/, which is what makes the chassis
  easy to reason about; everything else at the root is contract,
  packaging, or governance. Lands before stagecraft spec 002 so the
  first template consumer imports the simple shape.
---

# 019: Two-directory layout

## 1. Target tree (stamped-app view)

```
frontend/          the SPA source (vue today; flavors per spec 015)
backend/           the Encore.ts app
  auth/ idp/ hiq/ health/   services (unchanged internally)
  web/             static service serving frontend's build output
  core/            CoreLedger (decorators, drivers, repositories)
  lib/             shared security primitives
docker/            single-container packaging (app-owned)
scripts/           app-owned scripts only (generate-keys, rauthy sync)
specs/ standards/  the spec spine
template.toml      the factory contract
encore.app  package.json  tsconfig.json  vitest config  .github/
```

Gone from the stamped tree (all via spec 018): vendor/, addon/,
scripts/encore/. The template repo itself additionally keeps
packages/ and vendor/encore as toolchain source (018 §3).

## 2. Movement map

- `auth/ idp/ hiq/ health/ web/ core/ lib/` move under `backend/`
  unchanged internally (imports are relative within each service;
  cross-service imports go through `~encore` or `backend/lib`; fix
  paths mechanically).
- `webapp/` becomes `frontend/` (its package name stays
  `@enrahitu/webapp` or renames to `@enrahitu/frontend`; pick at
  implementation and update spec 006 + spec-spine.toml standalone
  lists together).
- `web/dist` placeholder tracking (the gitignore negation dance from
  spec 006) moves to `backend/web/dist`; frontend build output path
  updates accordingly.
- Root configs stay at root: `encore.app`, `tsconfig.json` (paths
  updated: `~encore/*` mapping and any service path assumptions),
  vitest config (include/exclude globs updated).

## 3. Risks the implementer must verify first

- **The vendored tsparser must accept nested services.** Upstream
  Encore.ts supports services in subdirectories; verify the pinned
  v1.57.9 parser walks `backend/*/encore.service.ts` correctly BEFORE
  moving anything (a five-minute scratch check: move one service,
  run build:app). If nested discovery fails, stop and report; do not
  invent a workaround shim silently.
- **Spec territory moves with the code.** Specs 001-008 and 011-017
  carry establishes edges naming the old paths (e.g. spec 011's
  core/ledger/postgres.ts, spec 017's e2e/, spec 002's addon
  references). Each moved path amends its owning spec in the SAME
  commit; the coupling gate exists precisely for this. Spec 011's
  reserved path becomes `backend/core/ledger/postgres.ts`.
- **template.toml**: verb commands and any path the contract exposes
  update together with a contract minor bump (spec 009 §3.1); the
  scaffold verb (spec 014) and flavor pruning (spec 015) operate on
  `frontend/` afterwards; those specs are amended here if they land
  after this one, or this spec's movement map executes on their
  updated shapes if they land first (the backlog order in AGENTS.md
  puts 018/019 first, so expect to amend 014/015's texts).
- **docker/**: entrypoint and Dockerfile path references
  (.encore/build outputs are path-stable; web/dist references are
  not) update and get an image smoke before merge.

## 4. Acceptance

In-repo (satisfied in this source tree):

- Full local gauntlet green on the new layout: npm ci, build:app,
  typecheck, vitest suite (39/39).
- verify.yml green (confirmed on push to main).
- `git log --follow` preserves history for moved files (moved with
  `git mv`; 61 renames, no delete + recreate).
- Every spec whose territory moved is amended in the same commit;
  spine gates green with zero waivers.

Consumer-side (delegated, verified outside this repo):

- A fresh stamp of the restructured template born green on CI, matching
  the enrahitu-stamp-smoke-1 precedent. Owned by the scaffold verb (spec
  014) / the stamped consumer, which produces the stamp repo and runs its
  born-green CI; not producible from this source repo.
- The full image build + boot smoke (`/health`, `/hiq/health`), owned by
  the packaging pipeline (spec 007/008) and spec 016's amd64 image work.
  The layout's only runtime impact (the SPA static dir, now
  `backend/web/dist`) is resolved into the app meta at parse time and is
  exercised by the local build; `docker-build.sh` was updated to copy it.

## 5. Out of scope

- Any behavioral change to services, auth, or packaging semantics;
  this spec moves files and updates references, nothing else.
- Monorepo tooling (turborepo, nx, npm workspaces): the root stays a
  single npm package with standalone frontend/ manifest (spec 001
  key decision 1 holds).
- Renaming services or splitting lib/.

## 6. Status

**2026-07-14 (layout landed).** The move landed in one commit: `auth/ idp/
hiq/ health/ web/ core/ lib/` moved under `backend/` via `git mv` (history
preserved, 61 renames), `webapp/` became `frontend/` (package renamed
`@enrahitu/webapp` to `@enrahitu/frontend`). Cross-service imports were
sibling-relative and survived the move unedited; `~encore/*` still resolves
through `encore.gen` at the app root. Every owning spec was amended in the
same commit: 001 (`backend/health/`), 002 (`backend/hiq/`; `addon/` stays at
root), 003 (`backend/core/`), 004 (`backend/auth/` + `backend/lib/`), 005
(`backend/idp/` + `backend/auth/rauthy.ts`), 006 (`frontend/` +
`backend/web/`), 011's reserved `backend/core/ledger/postgres.ts`; plus the
config owners 000 (spec-spine.toml standalone list), 007 (docker-build.sh +
.dockerignore), 010 (verify.yml). `template.toml` is unchanged: the contract
exposes no moved path (verbs are npm scripts + `scripts/docker-build.sh`, the
`frontend` slot is a flavor name), so no contract bump was required (spec 009
§3.1 condition not met).

Verified locally on the new layout: `build:app` (the pinned v1.57.9 tsparser
walks `backend/*/encore.service.ts` correctly, risk §3.1 cleared), `tsc
--noEmit`, `vitest` (39/39), `build:web` (outputs to `backend/web/dist`), and
the spine gates (`compile`, `index`, `lint --fail-on-warn`, `index check`)
all green with zero waivers.

**Completed 2026-07-15.** The in-repo acceptance holds: the local gauntlet
(npm ci, build:app, `tsc --noEmit`, vitest 39/39), verify.yml green on push to
main, history preserved via `git mv` (61 renames), and every moved spec
amended with zero waivers. The two residual checks are consumer-side and moved
to §4 "consumer-side (delegated)": the fresh born-green stamp needs the
scaffold verb (spec 014) or a stamp-smoke repo, and the full image boot smoke
is owned by the packaging pipeline (spec 007/008) and spec 016's amd64 work.
Neither is producible from this source repo; the layout's docker impact
(`backend/web/dist`, and `docker-build.sh` updated to copy it and drop
`frontend/` from the worktree) is resolved at parse time and covered by the
local build. Marked complete on maintainer direction.
