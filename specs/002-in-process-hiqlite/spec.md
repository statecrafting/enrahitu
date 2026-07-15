---
id: "002-in-process-hiqlite"
title: "In-process hiqlite via a napi-rs native addon"
status: approved
created: "2026-07-14"
implementation: complete
origin:
  retroactive: true   # phase 0 shipped before the spec graph existed
depends_on:
  - "001-enrahitu-architecture"
establishes:
  - { kind: directory, path: "addon/" }
  - { kind: directory, path: "hiq/" }
summary: >
  The hiqlite runtime embedded in the Node process: a napi-rs cdylib
  (@enrahitu/hiqlite-native) exposing init/health, TTL'd KV, and counters,
  plus the thin `hiq` Encore service that starts the node at service load
  and fronts the addon over HTTP. Replaces Redis for cache and rate-limit
  state with zero extra processes.
---

# 002: In-process hiqlite

## 1. Purpose

Cache/KV and counters without Redis and without a sidecar: hiqlite runs
inside the application process as a native addon. rauthy (spec 005) brings
its own embedded hiqlite, so the entire stack stays in the SQLite family.

## 2. Territory

- `addon/`: the Rust crate (`hiqlite-native`, napi-rs cdylib) and its npm
  packaging (`@enrahitu/hiqlite-native`). hiqlite is pinned `=0.14.0` with
  features `cache,counters,macros` (no SQLite-C). Cross-built for the image
  target (`linux-arm64-gnu` / `linux-x64-gnu`) because `encore build docker`
  does not compile Rust; the built `.node` artifacts and the napi-generated
  loader are gitignored (`addon/.gitignore`) and injected into the image
  worktree by spec 007's build script, which fails loudly when they are
  missing.
- `hiq/`: the Encore service over the addon. `hiq/init.ts` starts the
  hiqlite node at service load, not lazily (template-encore PR #40 caveat 5).

## 3. Behavior

- Addon surface: `init`, `health`, `kvPut` / `kvGet` / `kvDel` (TTL),
  `counterAdd` / `counterGet` / `counterSet` / `counterDel`.
- Configuration via `ENRAHITU_HIQ_*` env vars (data dir, raft/api bind
  addresses, secrets). In the packaged container the entrypoint assigns
  ports 8300/8400 because rauthy's embedded hiqlite owns 8100/8200 in the
  same network namespace (spec 007).
- HTTP surface (`hiq` service): `GET /hiq/health`, `POST /hiq/kv`,
  `GET|DELETE /hiq/kv/:key`, `POST /hiq/counter/:key/add`,
  `GET /hiq/counter/:key`.
- hiqlite runs **single-node**; `cache` + `counters` only.

## 4. Out of scope

- dlock and listen/notify: added to the addon only when a consumer exists.
- Clustering (StatefulSet raft) is out of scope for v0.

## 5. Publishing (amended by spec 018, 2026-07-14)

The addon keeps its package name `@enrahitu/hiqlite-native` and gains a
registry publish path so a stamped app installs a prebuilt binary instead of
copying the crate. The napi loader (`index.js`) already falls back to
per-platform packages `@enrahitu/hiqlite-native-<triple>`, so the manifest
drops `private`, and the spec 018 publish workflow
(`.github/workflows/publish.yml`) builds the three platform packages
(`darwin-arm64`, `linux-x64-gnu`, `linux-arm64-gnu`) via
`napi create-npm-dirs`/`artifacts` and injects them into the published meta
manifest as `optionalDependencies` at publish time. They are NOT committed to
`addon/package.json`: declaring them there churns `addon/package-lock.json`
across platforms (the transitive emnapi optional tree), which would break
`npm ci` in `verify.yml`. This repo still resolves the addon through the
`file:./addon` dependency and the locally built (gitignored) `.node`;
publishing is additive, not a replacement for the in-tree dev path.
