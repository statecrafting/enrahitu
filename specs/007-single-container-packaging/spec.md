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
  - "docker/entrypoint.test.ts"
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
  produced inside the worktree by the host `tsparser-encore`; every SPA
  flavor source directory (`frontend/`, `frontend-react/`; the template
  carries them all, spec 015) plus the `e2e/` suite (spec 017) is dropped
  from the worktree since their devDependencies are not installed there.
  Local secrets (.env, keys/,
  .data/) are never in the image. The script asserts the base image's
  entrypoint verbatim so `docker/entrypoint.sh` and the image layout move
  together. The `[arch]` argument (arm64 default, amd64) drives both the
  injected native artifacts and the `docker build --platform linux/<arch>`
  target, so the image arch and its addon `.node` + runtime `.so` always
  agree; a native artifact whose ELF arch does not match fails the build,
  not the first request (spec 016).
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

## Amendment (2026-07-22): repoint fallout in the image path (via spec 022)

The published-toolchain repoint (spec 018, PR #25) broke the packaged
image twice over, unnoticed because `image.yml` runs on cron/dispatch
and its last green run predates the repoint. Both surfaced by spec
022's packaged-image acceptance check:

- **Build**: the root `vitest.config.ts`/`vitest.setup.ts` now import
  `@statecrafting/toolchain` (a devDependency, absent in the image
  worktree's `npm ci --omit=dev` install), so the tsparser app walk
  failed to resolve them. `docker-build.sh` prunes both vitest files
  from the worktree alongside the frontend flavors and `e2e/`: tests
  never run in the image.
- **Boot**: the published platform carriers build their `.node`
  binaries on ubuntu-24.04 runners (glibc 2.39); the base image was
  bookworm-based `node:24-slim` (glibc 2.36), which refuses to load
  them (`ERR_DLOPEN_FAILED`). Before the repoint the binaries were
  cross-built in bookworm; now the published carriers are the source
  of truth, so the base moves to `node:24-trixie-slim` (glibc 2.41)
  to match them.
- **Kernel addon injection**: the target-arch injection step predates
  spec 021 and only knew the toolchain runtime, hiqlite addon, and
  libsql binding; a host-arch build left the image without
  `@statecrafting/kernel-native-<triple>` and the app failed at boot.
  The step now fetches and injects the kernel carrier identically,
  and the ELF arch check covers it.

## Amendment (2026-07-22b): the admin bundle in the image (spec 023)

`docker-build.sh` builds the operator dashboard (`npm run build:web-admin`)
when `frontend-admin/` is present (a stamped app with admin = "off"
carries neither the directory nor the script), injects
`backend/web/dist-admin/` into the worktree beside the SPA dist, and
prunes the `frontend-admin/` source with the other frontend directories.
`backend/admin/` ships with `backend/` as live service code.

## Amendment (2026-07-23): fleet-declared required env

The entrypoint gains a generic pre-flight assertion driven by one
variable: `ENRAHITU_REQUIRED_ENV`, a comma- or space-separated list
of environment variable names that must each be set and non-empty
before anything starts, first-boot provisioning included. All missing
names are collected and reported together, then the container exits
nonzero (the verify-born-with.mjs shape: every reason at once, one
failure). An unset or empty `ENRAHITU_REQUIRED_ENV` asserts nothing:
the required list is fleet-declared configuration, never substrate
policy (spec 001 §4.1: the substrate never assumes a platform above
it). The statecraft fleet's Deployment-command stopgap (statecraft
PR #64) reduces to setting this one variable.

## Amendment (2026-07-23b): the image runs as node (non-root)

The final image sets `USER node` (uid/gid 1000, the user every node
base image ships) and owns `/data` as `node:node` at image build, so a
fresh named volume inherits writable ownership. This lands the chassis
half of the statecraft finding: the fleet already runs the pod as uid
1000 with `fsGroup: 1000` (statecraft spec 006, E2E finding 3, fixed
fleet-side 2026-07-16), and statecraft spec 009 records that
"hardening the image to a non-root UID is an enrahitu chassis change,
not something to improvise in a Deployment". Nothing in the container
needs root: everything the runtime writes lives under `/data`
(rauthy's `data_dir` included), and both listeners (8080 app, 8081
rauthy loopback) are unprivileged ports.

Migration, stated honestly: a volume first populated by a pre-024
root-running container carries root-owned files the node user cannot
touch. Kubernetes heals this itself (`fsGroup` chowns volume contents
on mount); a plain-docker deployment needs a one-time
`chown -R 1000:1000` on the volume, and `docker run --user 0` remains
the escape hatch for a legacy volume that cannot be migrated yet.

## Amendment (2026-07-25): container stop must reach the supervised processes

The entrypoint supervises die-together but never handled its own stop
signal. It is PID 1 in the shipped image, so the runtime delivers SIGTERM
to it and to nothing else; with no trap installed, bash's default action
ended the shell alone and left rauthy and the app running until the grace
period expired and the runtime SIGKILLed them. The `kill` on the
die-together path (a supervised process exiting on its own) was the only
place either child was ever asked to stop.

rauthy is the process that pays for this. Its embedded hiqlite holds lock
files for the WAL and the state machine, and a SIGKILL never releases
them, so **every** boot after **every** ordinary restart begins unclean.
Observed on the live statecraft control plane 2026-07-25, on a boot that
had nothing else wrong with it:

```
WARN hiqlite_wal::log_store: LockFile /data/rauthy/db/logs exists already - this is not a clean start!
WARN hiqlite::store::state_machine::sqlite::state_machine: Lock file already exists: /data/rauthy/db/state_machine/lock
WARN hiqlite_wal::log_store: LockFile /data/rauthy/db/logs_cache exists already - this is not a clean start!
```

The warning is not the whole cost. On the same restart it escalated three
times to a hard failure before a boot got through:

```
thread 'tokio-rt-worker' panicked at hiqlite-wal-0.14.0/src/log_store.rs:47:21:
LockFile /data/rauthy/db/logs is locked and in use by another process
```

which aborts rauthy, which die-together turns into a container exit, which
the restart policy turns into a crash loop. Three restarts and about
forty-five seconds of extra downtime on a routine pod replacement, with
no bound on how many it could have been. This is the same failure shape as
the outage recorded in statecraft spec 009 (a rauthy abort the supervision
faithfully propagates), reached by a different route.

The fix is a stop handler that forwards the signal and waits for both
children before exiting, armed immediately after `RAUTHY_PID` is assigned
so a stop during the rauthy health wait is covered too. It exits 0: the
container was asked to stop and did.

`docker/entrypoint.test.ts` covers it, and covers the shipped function
rather than a copy of it: the test lifts the `shutdown()` body out of
`docker/entrypoint.sh` by text and runs it against stub children, so
editing the real function is what breaks the test. Four cases: both traps
are installed, SIGTERM and SIGINT each reach rauthy and the app, and a
signal arriving before the app has started still stops rauthy without
tripping over an unset `APP_PID`. The negative was verified by hand and is
worth recording, because it is the whole argument for the change: with the
trap removed the harness exits 143 and neither child is signalled at all.

This is the first test in the repo over `docker/`, which is the point. The
entrypoint is a shell script that has now caused two production incidents,
and "PID 1 forwards its signals" is exactly the kind of guarantee that no
TypeScript test can reach.

Consuming apps carry their own copy of this file (statecraft's diverges by
four hunks, recorded in its spec 002), so the same handler has to land in
each of them; it is not delivered by a pin.

## Amendment (2026-07-25b): a health check, and a provisioned metrics token (spec 025)

Two gaps in the packaged image, both from spec 025.

**`HEALTHCHECK`.** The image declared none, so a plain Docker or Compose
operator had no health signal at all. It now probes `/healthz`, the
dependency-free liveness endpoint spec 025 §3.3 separated out of
`/health`. The target matters as much as the check: pointing a liveness
probe at a dependency check means a transient ledger blip restarts the
container, and under the die-together supervision above that restart also
ends rauthy, turning a database wobble into an identity outage. `node -e`
with `fetch` does the probing, matching the entrypoint's existing idiom
(`node:24-trixie-slim` ships no curl).

**The `/metrics` bearer token.** `first-boot.mjs` provisions
`$DATA/keys/metrics-token` through the same `writeOnce` 0600 path as
every other secret, and the entrypoint exports it as
`ENRAHITU_METRICS_TOKEN`, letting an explicitly supplied value win so a
fleet can inject one shared token across cells. The packaged image is
therefore authenticated by default rather than opt-in, while spec 022's
always-on, unflagged contract for the endpoint is untouched (spec 025
§3.4). Provisioning stays write-once, so a restart never rotates a token
an operator has already configured a scraper against;
`docker/first-boot.test.ts` covers that property.
