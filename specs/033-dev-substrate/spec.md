---
id: "033-dev-substrate"
title: "The dev substrate: docker-only development and the app-level harness"
status: approved
created: "2026-07-29"
implementation: in-progress
depends_on:
  - "001-enrahitu-architecture"
  - "007-single-container-packaging"
  - "008-vendored-encore-toolchain"
  - "025-substrate-hardening"
  - "032-hiqlite-interface-contract"
establishes:
  - { kind: directory, path: "testing/" }
summary: >
  Phase 1b of the pivot (spec 001 §5.1). Development becomes docker-only, and
  the N=1 dev topology becomes the N=1 deployment topology rather than a
  parallel arrangement that resembles it. Five parts: a tiered compose
  topology whose default tier is one container and one volume; a single
  generator for infra.config.<topology>.json, replacing hand-maintained
  twins; a backend watch loop, which the toolchain's dev runner has never
  had; the app-level test harness, which boots the real compiled bundle and
  talks to it over HTTP; and the single-shot restore marker that makes
  HQL_BACKUP_RESTORE safe in a container with a restart policy. The harness
  landed first because it is what closes spec 025 and what specs 026, 027,
  and the control plane all build on, and because it immediately found two
  defects nothing else in the repo could see.
---

# 033: The dev substrate

## 1. Purpose

Two problems, one cause.

**Development and production were different systems.** Development ran the
app under plain node on the host with rauthy in a hand-started compose
container; production ran one container with both processes under
`entrypoint.sh`, different key provisioning, a different infra config, and a
different cookie posture. That is the machine that produces defects visible
only in CI, and it has produced them: spec 017's login e2e needed three
separate environment-shaped fixes that no local run could reveal.

**Nothing could test an endpoint.** Every test in this repo was either a
pure module test or a subprocess test of a shell script. Neither can answer
"does the running gateway refuse this request?", which is the only question
that matters for a surface a stranger can reach. Spec 025 shipped four
acceptance items it could not prove for exactly that reason, and it said so
rather than pretending otherwise.

The cause is shared: there was no single way to bring the application up, so
there was nothing for a harness to target and nothing for production to
resemble. Spec 001 §4.1 deletes the zero-docker development invariant, which
makes one answer available for both.

## 2. Territory

Owned now:

- `testing/`: the app-level harness and the endpoint suites built on it.

  **At the repo root, not under `backend/`, and the extraction gate is why.**
  The extractor's usage walk treats every non-`.test.ts` file under `backend/`
  as application code and refuses bare `fetch()` there, because ungoverned
  egress from a service is exactly what `backend/kernel/egress.ts` exists to
  prevent. A harness whose entire job is to make HTTP requests at the
  application from outside is not application code. Placing it under
  `backend/` would have forced a choice between weakening that ban and
  misdescribing the file; placing it at the root makes the ban and the truth
  agree. `e2e/` (spec 017) is the existing precedent, and spec 019 already
  reserves the root for what is not an Encore.ts concern.

Owned when the §3.3 to §3.5 work lands, and deliberately absent from
`establishes` until then, because a declared file unit that does not exist
is a blocking index diagnostic and this spec should not need a waiver to
describe its own future:

- `docker/compose.yml`: the default (N=1) dev topology. The cluster topology
  is spec 030's `compose.cluster.yml`; `compose.dev.yml` (spec 005's
  standalone rauthy) retires into this file.
- `docker/Dockerfile.dev`: the dev image.
- `scripts/gen-infra-config.mjs`: the infra config generator.
- `scripts/dev-watch.mjs`: the backend watch loop.

It amends, without owning, `docker/first-boot.mjs` (spec 007): the restore
marker in §3.5.

## 3. Behavior

### 3.1 The app-level harness (delivered)

`testing/app-harness.ts` boots
`.encore/build/combined/combined/main.mjs`, the same bundle the dev runner
runs and the same one the container runs, under a throwaway data directory
with freshly minted RS256 keys and OS-allocated ports. Requests go over real
HTTP through the real gateway, so middleware, the auth handler, the kernel,
and the Encore router are all in the path. Nothing is stubbed.

It carries a cookie jar, because the session is httpOnly cookies (spec 004)
and `fetch` does not persist them: without one, the harness could only ever
test the unauthenticated surface, which is half the point.

**Two constraints discovered by building it**, both recorded because they
are invisible until something boots the bundle from inside a test runner:

1. **The child must not inherit the test runner's environment.** Vitest sets
   `NODE_ENV=test` and a family of `VITEST_*` markers; inherited, they put
   the Encore runtime in test mode, where it never opens its API listener.
   The symptom is a boot that logs nothing and times out, which reads like a
   hung application rather than a misconfigured one.
2. **`NODE_ENV=development` is the only correct default.** `test` is the trap
   above, and `production` disables the mock auth driver
   (`isMockEnabled()` is `!env.isProduction`), leaving the harness unable to
   hold a session. Both wrong answers fail in ways that look like application
   bugs.

That second constraint turned into coverage: an instance booted with
`NODE_ENV=production` proves the mock driver is absent, which nothing
previously asserted. `isMockEnabled()` is one line, and a regression that
inverted it would hand any visitor an admin session by URL. That is the same
class of defect the spec 025 exposure review found elsewhere, and it now has
a test.

**Cost, stated so the harness is used correctly.** Boot takes seconds, most
of it the hiqlite raft election, so one instance per test file in
`beforeAll`, never per test. It requires a prior `npm run build:app`;
`isAppBuilt()` reports that and suites skip rather than fail, because CI
always builds first (`verify.yml`) and a developer may not have.

### 3.2 What the harness found immediately

A harness earns its place by finding things, and this one did so before it
had a second suite.

**`encore.dev` had drifted from the runtime.** The manifest declared
`^1.57.9`, npm resolved 1.57.12, and the toolchain's runtime binary is
v1.57.9. The runtime prints a version-mismatch warning on every boot saying
this "may cause unexpected behaviour" and continues. Nothing in the repo
booted the bundle against the runtime, so nobody ever saw it: the dev runner
prints it to a terminal a developer is not reading, and no test started the
app at all. `encore.dev` is now pinned exactly, because a caret range across
a napi ABI boundary is a floating mismatch waiting to happen rather than a
convenience.

### 3.3 Tiered topology, docker only

Development is docker-only (spec 001 §4.1), tiered by N rather than by
whether infrastructure is involved:

- **The default tier is N=1**: one container, one volume, one command, rauthy
  on loopback and the app on the published port, exactly as the packaged
  image runs. Source is bind-mounted and the watch loop (§3.4) rebuilds in
  place, so the topology is production's while the iteration loop is not.
- **The cluster tier** is spec 030's `compose.cluster.yml`.

`docker/compose.dev.yml` (spec 005's standalone rauthy, started by hand
alongside a host-run app) retires into `compose.yml`. It existed because the
app ran on the host; once the app is in the topology there is nothing for a
separate rauthy compose file to be separate from.

The N=1 tier is the same shape as the N=1 deployment, which is the property
that makes the divergence in §1 unrepeatable. It is not the same *image*:
the dev image mounts source and carries a toolchain, the packaged image
carries a built bundle and no build inputs (spec 007). Topology is shared,
build posture is not, and conflating them would put a compiler in the
production image.

### 3.4 One generated infra config, and a watch loop

**Generated infra config.** `infra.config.json` and `infra.config.dev.json`
are hand-maintained twins today, and spec 030 adds a third with its `pubsub`
block. Three files that must agree and nothing that makes them agree is a
drift generator. `scripts/gen-infra-config.mjs` emits
`infra.config.<topology>.json` from one declarative source.
`augmentInfraConfig` in the toolchain is the precedent: it already merges
the compile step's hosted services and gateways into the base at build time.

**Watch.** The toolchain's dev runner builds once and runs; there is no
watch, so every backend edit is a manual full rebuild. The frontend has Vite
HMR and the backend has nothing, which is an asymmetry nobody chose.
`scripts/dev-watch.mjs` watches the backend sources, debounces, rebuilds
through the toolchain driver, and restarts the app process. It lives here
rather than in the toolchain because the rebuild granularity is an
application concern and the toolchain ships on a different cadence.

### 3.5 The restore marker

Spec 032 §3.9 requires it and states the failure: `HQL_BACKUP_RESTORE` left
set in a container with a restart policy **re-applies the backup on every
restart and discards everything written since**, so a crash loop becomes
silent repeated data loss. rauthy's own configuration documents "remove the
value after the restart", which is a runbook step standing between a tenant
and their data.

Restore therefore routes through `docker/first-boot.mjs`, which writes a
marker into the volume recording which backup was applied and refuses to
apply it twice. The operator sets the variable once; the platform makes it
single-shot. Designing it out beats documenting around it.

## 4. Acceptance

1. The harness boots the real bundle and serves real HTTP, with one instance
   per file. **Met.**
2. `/metrics` returns 401 unauthenticated, 401 for a wrong bearer, and 200
   with Prometheus exposition format for the right one. This is spec 025
   acceptance item 6, previously unprovable. **Met.**
3. The retired `hiq` write endpoints are unrouted (404) and `GET /hiq/health`
   is public. **Met.**
4. A full session lifecycle works over the wire: sign in, `/me`, sign out,
   `/me` refused after. **Met.**
5. A state-changing request without the CSRF header is refused with
   `CSRF_MISSING`, while the session survives the refusal. **Met**, and it is
   an assertion no unit test of the middleware can make, because it depends
   on the cookie and the header travelling together.
6. `NODE_ENV=production` disables the mock driver and mints no session.
   **Met.**
7. `encore.dev` is pinned to the runtime's exact version and the boot warning
   is gone. **Met.**
8. `docker compose up` brings the N=1 topology up with no arguments, and a
   backend edit is live without a manual rebuild. **Pending.**
9. Every `infra.config.<topology>.json` is generated, and a drift check fails
   if a committed one differs from its regeneration. **Pending.**
10. A container restarted twice with `HQL_BACKUP_RESTORE` still set applies
    the backup exactly once. **Pending.**

## 5. Status

**2026-07-29.** Section 3.1 and 3.2 are delivered: the harness, eighteen
endpoint-level assertions, and the `encore.dev` pin. Spec 025 moves to
`implementation: complete` on the back of it (see that spec's §5).

Sections 3.3 through 3.5 are pending. They are separated deliberately rather
than by running out of room: the harness is what unblocks specs 026 and 027
and the control plane, so it ships on its own rather than waiting behind a
compose topology that nothing else depends on yet.

## 6. Out of scope

- The cluster topology and its Kubernetes placement: spec 030.
- The restore verb, its runbook, and the tenant assurance: spec 027. This
  spec owns only the marker that makes restore single-shot.
- Hot module replacement for the backend. The watch loop rebuilds and
  restarts; an in-process module swap is a different and much larger
  problem, and the rebuild is seconds.
- Replacing the Playwright e2e (spec 017). It drives a real browser against
  a real rauthy and answers a question this harness does not: whether a human
  can log in. Moving it onto the compose topology is §3.3's job; retiring it
  is not a goal.
