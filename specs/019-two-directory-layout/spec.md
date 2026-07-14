---
id: "019-two-directory-layout"
title: "Template layout: frontend/ + backend/, nothing else to explain"
status: approved
created: "2026-07-14"
implementation: pending
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

- Full local gauntlet green on the new layout: npm ci, build:app,
  typecheck, vitest suite, and an image build + boot smoke
  (`/health`, `/hiq/health`).
- verify.yml green; a fresh manual stamp (spec 014 recipe or scaffold
  verb) of the restructured template is born green on CI, matching
  the enrahitu-stamp-smoke-1 precedent.
- `git log --follow` preserves history for moved files (move with
  `git mv`; no delete + recreate).
- Every spec whose territory moved is amended in the same commit;
  spine gates green with zero waivers.

## 5. Out of scope

- Any behavioral change to services, auth, or packaging semantics;
  this spec moves files and updates references, nothing else.
- Monorepo tooling (turborepo, nx, npm workspaces): the root stays a
  single npm package with standalone frontend/ manifest (spec 001
  key decision 1 holds).
- Renaming services or splitting lib/.
