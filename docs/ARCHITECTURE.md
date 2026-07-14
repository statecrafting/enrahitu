# enrahitu architecture

> Human overview. The authoritative design record is the spec spine: every
> decision here graduated into `specs/NNN-*/spec.md` in Phase 6 (thesis and
> shell: 001; hiqlite: 002; CoreLedger: 003; auth: 004; rauthy/IdP: 005;
> SPA: 006; packaging: 007). Where this doc and a spec disagree, the spec
> wins.
>
> **enrahitu** (EnRaHiTu: Encore.ts + rauthy + hiqlite + Turso; formerly
> enrahi / enrahi-kit) vendors the Encore toolchain
> (spec 008): `vendor/encore/` carries upstream encoredev/encore @ v1.57.9
> (the rust runtime core, the napi-rs JS bindings built into
> `encore-runtime.node`, the `tsparser-encore` parser/compiler, and the
> published `encore.dev` JS runtime), and `scripts/encore/` drives it. Dev
> runs, typechecking, tests, and image builds work without the `encore`
> CLI; every phase-0-through-5 behavior below is otherwise unchanged.

## Thesis

Encore.ts is an excellent application framework, but its business model
monetizes cloud provisioning, so its primitives (notably `SQLDatabase`) couple
application code to managed infrastructure. enrahitu keeps the framework and
severs the coupling:

- **hiqlite, in-process** (napi-rs addon): cache/KV, counters (rate limiting),
  later dlock + listen/notify. No Redis, no sidecar.
- **libSQL / Turso** (CoreLedger): durable relational data in a local SQLite
  file by default; the same driver speaks Turso embedded-replica sync
  (`syncUrl` + `authToken`) for managed offsite durability; a Postgres driver
  slots in behind the same decorator surface when scale demands it.
- **rauthy, same container**: the OIDC IdP ships inside the app image (rauthy
  is itself hiqlite-backed, keeping the entire stack in the SQLite family).

Result: one Docker image + one volume = a complete authenticated application.
Development and early deployment cost nothing but a container host; scaling is
"point CoreLedger at managed Postgres", not a rewrite.

## Lineage

- **stagecraft-ing/template-encore PR #40** proved Shape A: a napi-rs addon
  linking hiqlite runs in-process under `encore run` AND inside an
  `encore build docker` image (two tokio runtimes, separate dylibs, no
  contention). The spike's caveats drive our hardening:
  1. cross-build the linux `.node` yourself (encore does not compile Rust)
  2. `file:` addon dep resolves in-image only because `bundle_source: true`
     copies the tree; acceptable in this single-package repo, revisit if the
     addon is ever published
  3. keep the bundle lean via `.dockerignore` (no workspaces in this repo,
     which was the 3.7 GB failure mode)
  4. the self-host gateway binds `0.0.0.0:8080`
  5. start hiqlite at service init, not lazily
- **template-encore `apps/api`** is the reference for the auth model
  (stateless RS256 JWT in httpOnly cookies, rotated DB-backed refresh tokens,
  CSRF double-submit, roles, audit), re-based here from Encore
  `SQLDatabase`/Postgres onto CoreLedger + hiqlite.

## Components

| Component | Where | Role |
|-----------|-------|------|
| `addon/` (`@enrahitu/hiqlite-native`) | Rust, napi-rs cdylib | in-process hiqlite: `init`, `health`, `kvPut/kvGet/kvDel` (TTL), `counterAdd/Get/Set/Del`. hiqlite `=0.14.0`, features `cache,counters,macros` (no SQLite-C). Env: `ENRAHITU_HIQ_*`. |
| `hiq/` | Encore service | thin API over the addon; starts the node at service load (`hiq/init.ts`) |
| `core/` | library | CoreLedger: stage-3 `@Entity`/`@Column` decorators, `LedgerDriver` interface, libSQL driver (local file + Turso replica), `ensureSchema()`, typed repositories (Phase 1) |
| `auth/` | Encore service | mock + rauthy OIDC drivers, JWT cookies, refresh rotation, CSRF, roles, audit on CoreLedger; rate limiting on hiqlite counters (Phase 2) |
| `idp/` | Encore service | raw passthrough proxy mounting `/auth/*` onto rauthy (`RAUTHY_UPSTREAM`, default `127.0.0.1:8081`), one public origin for app + IdP (Phase 3; fallback: expose rauthy on a second port) |
| `webapp/` | Vue 3 + Vite | minimal SPA: login, callback, `/me`, logout; served by the app in prod (Phase 4) |
| `health/` | Encore service | liveness (+ Phase 0 decorator canary) |
| `docker/` | packaging | final image: `encore build docker` output + rauthy binary + entrypoint supervising both (Phase 5) |

## Key decisions

1. **Single-package repo, app at the root.** No npm workspaces: workspaces
   made `bundle_source` treat the workspace root as bundle root in the spike
   (caveat 3). `addon/` and `webapp/` have their own `package.json`s but are
   not workspace members.
2. **No Encore `SQLDatabase` anywhere.** `encore run` must not want Docker
   Postgres; `encore build docker` must not require database infra config.
   Durable state is CoreLedger's job.
3. **Decorators are the CoreLedger API from day one.** Stage-3 TS decorators
   (no `experimentalDecorators`, no `emitDecoratorMetadata`); metadata lives
   in module-level registries, not `Symbol.metadata` (Node support not
   assumed).
4. **rauthy is reached through the app's origin.** The `idp` service proxies
   `/auth/*` to the in-container (prod) or docker-compose (dev) rauthy, so
   issuer, callback, and SPA share one origin: one exposed port (8080), no
   CORS between app and IdP.
5. **One process supervisor, die-together.** The final image runs rauthy +
   the Encore app under a minimal entrypoint (`wait -n`); if either exits the
   container exits and the restart policy recovers. No s6/supervisord in v0.
6. **Volume layout**: `/data/ledger` (libSQL file), `/data/hiqlite` (raft
   WAL/snapshots), `/data/rauthy` (rauthy's own hiqlite). One volume mount.
7. **hiqlite runs single-node.** `counters` + `cache` only; dlock and
   listen/notify features are added to the addon when a consumer exists.
   Clustering (StatefulSet raft) is explicitly out of scope for v0.

## Phases

| Phase | Deliverable | Status |
|-------|-------------|--------|
| 0 | repo scaffold + hardened addon + hiq service green under `encore run` | done |
| 1 | CoreLedger decorator data layer (libSQL local + Turso sync) | done |
| 2 | auth on CoreLedger + hiqlite rate limiting (mock driver) | done |
| 3 | rauthy same-origin proxy + OIDC driver + client bootstrap | done |
| 4 | minimal SPA + static serving | done (interactive rauthy password login still owed a browser click-through; rauthy's PoW-gated login form resists headless testing) |
| 5 | single Docker image (app + rauthy), smoke-tested | done (2026-07-14: first-boot provisioning, same-origin discovery, PKCE login redirect, restart idempotency all verified) |
| 6 | spec-spine + `.claude` retrofit (specs back-written from this doc) | done (specs 000-007; kit skills/agents/rules; CI coupling gate) |
