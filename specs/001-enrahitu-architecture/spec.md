---
id: "001-enrahitu-architecture"
title: "enrahitu: a self-contained single-container application core"
status: approved
created: "2026-07-14"
implementation: complete
origin:
  retroactive: true   # back-written from docs/ARCHITECTURE.md after phases 0-5 shipped
depends_on:
  - "000-bootstrap"
establishes:
  - { kind: directory, path: "health/" }
  - "encore.app"
  - "tsconfig.json"
  - "vitest.config.ts"
  - "vitest.setup.ts"
summary: >
  The architecture thesis and the app shell. Encore.ts is kept as the
  application framework while its managed-infrastructure coupling is severed:
  in-process hiqlite replaces Redis, CoreLedger on libSQL/Turso replaces
  Encore SQLDatabase, and rauthy ships inside the app image as the OIDC IdP.
  One Docker image plus one volume is a complete authenticated application.
  This spec owns the repo-shell units (Encore app manifest, TypeScript and
  test configuration, the health service) and anchors the root package;
  each subsystem is governed by its own spec (002-007). This repository is
  enrahitu (EnRaHiTu: Encore.ts + rauthy + hiqlite + Turso; formerly
  enrahi / enrahi-kit): the Encore toolchain is vendored and driven
  directly via napi-rs instead of through the encore CLI (spec 008), and
  the repo doubles as the template chassis the Stagecraft factory stamps
  (spec 009).
---

# 001: enrahitu architecture

## 1. Purpose

Encore.ts is an excellent application framework, but its business model
monetizes cloud provisioning, so its primitives (notably `SQLDatabase`) couple
application code to managed infrastructure. enrahitu keeps the framework and
severs the coupling:

- **hiqlite, in-process** (napi-rs addon, spec 002): cache/KV and counters
  (rate limiting); no Redis, no sidecar.
- **libSQL / Turso via CoreLedger** (spec 003): durable relational data in a
  local SQLite file by default; the same driver speaks Turso embedded-replica
  sync for managed offsite durability; a Postgres driver slots in behind the
  same decorator surface when scale demands it.
- **rauthy, same container** (specs 005 and 007): the OIDC IdP ships inside
  the app image; rauthy is itself hiqlite-backed, keeping the entire stack in
  the SQLite family.

Result: one Docker image + one volume = a complete authenticated application.
Development and early deployment cost nothing but a container host; scaling is
"point CoreLedger at managed Postgres", not a rewrite.

## 2. Territory

The repo shell: the Encore app manifest (`encore.app`), TypeScript
configuration (`tsconfig.json`), the vitest configuration and setup, and the
`health/` service (liveness endpoint at `GET /health` plus the phase-0
decorator canary). The root `package.json` links to this spec via its
manifest key; the subsystem directories are owned by specs 002-007.

## 3. Behavior

Repo-shaping decisions (back-written from `docs/ARCHITECTURE.md`, Key
decisions 1 and 2):

1. **Single-package repo, app at the root.** No npm workspaces: workspaces
   made `encore build docker`'s `bundle_source` treat the workspace root as
   the bundle root in the template-encore PR #40 spike (the 3.7 GB failure
   mode). `addon/` and `webapp/` have their own `package.json`s but are not
   workspace members.
2. **No Encore `SQLDatabase` anywhere.** `encore run` must not want Docker
   Postgres; `encore build docker` must not require database infra config.
   Durable state is CoreLedger's job (spec 003).
3. **Stage-3 TypeScript decorators only.** No `experimentalDecorators`, no
   `emitDecoratorMetadata`; metadata lives in module-level registries.
4. **No encore CLI (enrahitu).** The root package is `enrahitu`; dev
   runs, typechecking (`tsc --noEmit`), tests, and image builds all use the
   vendored toolchain (spec 008). `tsconfig.json` excludes `vendor/` and
   `.encore/` from the walk; `vitest.config.ts` resolves the napi runtime
   from the vendored build.

### Lineage

- **stagecraft-ing/template-encore PR #40** proved a napi-rs addon linking
  hiqlite runs in-process under `encore run` AND inside an
  `encore build docker` image (two tokio runtimes, separate dylibs, no
  contention). Its caveats drive the hardening in specs 002 and 007.
- **template-encore `apps/api`** is the reference for the auth model,
  re-based here from Encore `SQLDatabase`/Postgres onto CoreLedger + hiqlite
  (spec 004).

## 4. Out of scope

- Subsystem behavior: owned by specs 002 (hiqlite), 003 (CoreLedger),
  004 (auth), 005 (rauthy/IdP), 006 (SPA), 007 (packaging).
- hiqlite clustering (StatefulSet raft) is explicitly out of scope for v0.
- Kubernetes/Helm deployment artifacts: none exist yet; a future spec owns
  them when they do.
