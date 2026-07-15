---
id: "007-single-container-packaging"
title: "Single-container packaging: app + rauthy in one image"
status: approved
created: "2026-07-14"
implementation: complete
origin:
  retroactive: true   # phase 5 shipped before the spec graph existed
depends_on:
  - "002-in-process-hiqlite"
  - "005-rauthy-same-origin"
  - "006-webapp-spa"
establishes:
  - "docker/Dockerfile"
  - "docker/entrypoint.sh"
  - "docker/first-boot.mjs"
  - "scripts/docker-build.sh"
  - "infra.config.json"
  - ".dockerignore"
summary: >
  The deliverable image: one container running rauthy (loopback :8081) and
  the Encore app (:8080) under a die-together entrypoint, all durable state
  on a single /data volume, every secret self-provisioned at first boot.
  scripts/docker-build.sh builds from a clean git worktree of HEAD, injects
  the cross-built addon, the built SPA, and production node_modules, runs
  `encore build docker`, asserts the base-image entrypoint, and layers
  rauthy + the entrypoint on top.
---

# 007: Single-container packaging

## 1. Purpose

"One Docker image + one volume = a complete authenticated application"
made literal: `docker run -v data:/data -p 8080:8080 enrahitu` is a full
deployment. No compose file, no sidecars, no secret management
prerequisites.

## 2. Territory

- `scripts/docker-build.sh`: the build pipeline (amended by spec 008: the
  vendored toolchain replaced `encore build docker`). The script builds
  from a CLEAN git worktree of HEAD and injects exactly four artifact
  kinds: the cross-built native addon, the built SPA (`backend/web/dist`),
  production node_modules (`npm ci --omit=dev` plus the linux libsql
  binding npm-on-macOS never installs), and the cross-built Encore napi
  runtime (`docker/encore-runtime.node`). The app bundle + metadata are
  produced inside the worktree by the host `tsparser-encore`; the SPA
  source (`frontend/`) is dropped from the worktree since its
  devDependencies are not installed there. Local secrets (.env, keys/,
  .data/) are never in the image. The script asserts the base image's
  entrypoint verbatim so `docker/entrypoint.sh` and the image layout move
  together.
- `docker/Dockerfile`: layers the rauthy binary (from
  `ghcr.io/sebadob/rauthy`, single dynamically-linked binary, same Debian
  family as `node:24-slim`), the prod rauthy config (spec 005), first-boot,
  and the entrypoint onto the app base image built by
  `docker/Dockerfile.base` (spec 008).
- `docker/entrypoint.sh`: die-together supervision (`wait -n`): rauthy on
  loopback :8081, the app gateway on :8080 proxying `/auth/*`; if either
  process exits, the container exits and the restart policy recovers it.
  Assigns the app's hiqlite raft/api to 8300/8400 (rauthy's embedded
  hiqlite owns 8100/8200 in the shared namespace).
- `docker/first-boot.mjs`: idempotent provisioning under `/data`: RS256
  JWT keypairs, the rauthy client secret, the rauthy admin bootstrap
  password, runtime secrets (enc keys, hiqlite raft/api), and the
  declarative client bootstrap derived from `ENRAHITU_PUBLIC_URL`. Existing
  material is never overwritten, so restarts and upgrades keep their
  identity.
- `infra.config.json`: the Encore self-host runtime config binding the
  app's secrets to `$env` references resolved from first-boot material;
  the build script augments it with the hosted services/gateways from the
  compile result (spec 008) into the image's `/encore/infra.config.json`.
- `.dockerignore`: context hygiene for both image builds; also keeps the
  vendored Rust toolchain (everything but the encore.dev JS runtime) out
  of the image and its context upload.

## 3. Behavior

- **Volume layout** (ARCHITECTURE.md Key decision 6): `/data/ledger`
  (libSQL file), `/data/hiqlite` (app raft WAL/snapshots), `/data/rauthy`
  (rauthy's own hiqlite + secrets), `/data/keys` (JWT + client-secret
  material). One volume mount.
- **One supervisor, die-together** (Key decision 5): no s6/supervisord in
  v0.
- `ENRAHITU_PUBLIC_URL` is the single external-identity input: it derives
  rauthy's PUB_URL/RP_ID/RP_ORIGIN, the OIDC redirect URIs, and the
  issuer; an `https` public URL enables rauthy PROXY_MODE for external TLS
  termination. A plain-http public URL (a local trial) additionally sets
  rauthy `COOKIE_MODE=danger-insecure`: the default `__Host-`/Secure
  session cookie is refused by Safari over http even on localhost, which
  breaks every login with a sub-millisecond 401. The app's own cookies
  follow the same scheme rule (spec 004).
- The entrypoint waits for rauthy health on loopback before starting the
  app, so OIDC discovery never races rauthy startup.
- Verified 2026-07-14 by the phase-5 smoke test: first-boot provisioning,
  same-origin discovery, PKCE login redirect, authorize page via the
  proxy, restart idempotency (no material regenerated), and the /data
  layout above.

## 4. Out of scope

- Orchestration (Kubernetes, Helm, restart policies beyond Docker's own).
- Multi-arch manifest publishing and registry distribution (the build
  script accepts `arm64`/`amd64` per invocation).
- TLS termination: external (reverse proxy / platform), signalled via the
  `https` public URL.
