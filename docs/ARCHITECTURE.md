# enrahitu architecture

> Human overview. The authoritative design record is the spec spine under
> `specs/`. Where this document and a spec disagree, the spec wins;
> `specs/001-enrahitu-architecture/spec.md` is the thesis and its §5.2 records
> the disposition of every other spec.
>
> **enrahitu** is a proper noun. Its former expansion (Encore + rauthy +
> hiqlite + Turso) no longer describes the stack, because Turso is benched
> (spec 001 §4.7). Lineage: formerly `enrahi` / `enrahi-kit`.

## Thesis

Encore.ts is an excellent application framework, but its business model
monetizes cloud provisioning, so its primitives (notably `SQLDatabase`) couple
application code to managed infrastructure. enrahitu keeps the framework and
severs the coupling: **one container + one volume = a complete authenticated
application.**

**N=1 is the primary mode, not a degenerate case.** One container, one volume,
one command, no external infrastructure, and that is what most deployments run
forever. Three or five nodes is the additional case, not the real one.

The substrate is shipped as a working application that organizations extend
rather than fork, and it is also the template chassis the Statecraft factory
stamps (spec 009). Your code lives in `app/`, which is the one directory an
upgrade never touches (spec 035); everything else is chassis and is replaced
wholesale.

## Layer ownership, with no overlap

This is the part that most often gets misremembered, so it is stated plainly:

- **Encore.ts holds the edge**: the API surface, contracts, generated clients,
  and the external seams declared in `infra.config.json`. It is *not* the
  process supervisor.
- **rauthy holds identity**: authentication and principal identity, reached
  only through the app's own origin, consumed at its API surface and never
  forked. It is *not* a login page.
- **hiqlite holds state and coordination**, in-process via a napi-rs addon. It
  is *not* a cache.
- **Application code holds intent and reconciliation**: typed, tenant-scoped
  resources admitted through a kernel, with a hash-chained Decision ledger
  recording every admitted mutation.

## The planes

### Application plane

The member-facing product and the edge that serves it.

| Directory | Role | Spec |
|---|---|---|
| `backend/core/` | CoreLedger: stage-3 `@Entity`/`@Column` decorators, `LedgerDriver` interface, libSQL driver, typed repositories | 003, 011 |
| `backend/members/` | membership domain: members, tiers, renewals, dues | 036 |
| `backend/mail/` | application mail: transport, outbox, delivery loop | 037 |
| `backend/web/` | Encore static service serving the built SPA | 006 |
| `frontend/` | React 19 + React Router v7 SPA, builds into `backend/web/dist` | 015 |
| `app/` | your code: the one directory an upgrade never replaces | 035 |

### Identity plane

| Directory | Role | Spec |
|---|---|---|
| `backend/auth/` | JWT cookies, refresh rotation, mock + rauthy OIDC drivers, roles, audit | 004 |
| `backend/idp/` | same-origin `/auth/*` passthrough proxy onto rauthy | 005 |
| `backend/lib/` | shared security library: jwt, cookies, csrf, rate limiting, client identity | 004 |

rauthy runs in the same container on loopback `:8081` and is reached only
through the app's origin. There is never a second public origin for the IdP.

### Governance plane

Where intent becomes a recorded decision.

| Directory | Role | Spec |
|---|---|---|
| `backend/kernel/` | kernel-native adjudication and the hash-chained Decision ledger | 021, 024 |
| `backend/control/` | kinds, admission, watch, controllers, audit | 034 |
| `backend/state/` | governed facade over hiqlite's SQL, watch, lease and backup surfaces | 032 |
| `.derived/`, `specs/` | the app model and the spec registry: what this app is allowed to be | 020, 000 |

The app model (spec 020) is machine-readable and carries its own canonical
`integrity.hash`, which is the model's identity: an archive records it so a
restore into a different image can say so.

### Observability plane

| Directory | Role | Spec |
|---|---|---|
| `backend/obs/` | `/metrics` (token-authenticated, always on), OTel tracer, bounded trace buffer | 022, 025 |
| `backend/health/` | `/healthz` liveness (touches nothing), `/readyz` readiness | 025 |
| `backend/admin/` | operator dashboard data plane and gated `/admin` serving | 023, 031 |
| `frontend-admin/` | the operator dashboard SPA, builds into `backend/web/dist-admin` | 023 |

### Packaging plane

| Directory | Role | Spec |
|---|---|---|
| `backend/hiq/` | addon init, the state-machine lock reclaim, `GET /hiq/health` | 002 |
| `docker/` | the single-container image, entrypoint, first-boot provisioning, dev topology | 007, 033 |
| `scripts/ops/` | the operational verbs: preflight, migrate, backup, restore | 027 |
| `template.toml` | the versioned template contract the factory reads | 009 |

The image runs rauthy and the Encore app under one entrypoint with
die-together supervision: if either exits, the container exits and the restart
policy recovers it. Volume layout is `/data/ledger`, `/data/hiqlite`,
`/data/rauthy`, `/data/keys`, one mount.

## Key decisions

1. **No Encore `SQLDatabase` anywhere.** The ban is on the primitive: adopting
   it puts Encore in charge of durable state and its migrations, displacing the
   state layer this substrate owns.
2. **Single-package repo, no npm workspaces.** `frontend/` and
   `frontend-admin/` have standalone manifests but are not workspace members.
3. **Stage-3 TS decorators only**, no `experimentalDecorators`; metadata lives
   in module-level registries.
4. **rauthy is reached through the app's origin.** One exposed port, no CORS
   between app and IdP, no second origin to configure or leak.
5. **One supervisor, die-together.** No s6, no supervisord.
6. **Secrets are first-boot-provisioned in the container**, write-once, so a
   restart or an upgrade never rotates material an operator configured against.
7. **Development is docker-only.** `docker compose -f docker/compose.yml up`
   runs the same topology the packaged image runs, under the same entrypoint,
   differing only in that source is mounted and rebuilt on change (spec 033).
8. **The toolchain is a published dependency.** The Encore rust runtime core
   and TS parser/compiler arrive as prebuilt per-platform binaries via
   `@statecrafting/toolchain` and are driven directly through napi-rs. The
   `encore` CLI is not used anywhere (spec 008).

## Build-out history

The phase plan below described the original build-out and is kept as a record
of how the substrate got here. It is history, not a roadmap: the current work
is tracked by the spec corpus and spec 001 §5.1.

| Phase | Deliverable |
|---|---|
| 0 | repo scaffold, hardened addon, hiq service green |
| 1 | CoreLedger decorator data layer |
| 2 | auth on CoreLedger, hiqlite rate limiting |
| 3 | rauthy same-origin proxy, OIDC driver, client bootstrap |
| 4 | minimal SPA and static serving |
| 5 | the single Docker image, smoke-tested (2026-07-14) |
| 6 | spec-spine retrofit: specs back-written, coupling gate in CI |

Since phase 6 the corpus has continued past the phase model entirely: the app
model and kernel adjudication (020, 021), the Decision chain (024),
observability and hardening (022, 025), the operator dashboard (023), the
operational verbs (027), the control plane (034), the chassis boundary (035),
and the application domain itself (036 membership, 037 mail, 038 board
governance).

The 2026-07-27 pivot is the one piece of history that still changes how to read
the corpus: it moved hiqlite from cache to state layer, made N=1 primary, made
development docker-only, and deleted the idea of a prunable example slot. Spec
001 §2 carries the rewrite record and §5.2 says, per spec, whether it is
current, rewritten, or rewrite-pending.

## Where to go next

- `docs/OPERATIONS.md`: installing, TLS, probes, backup, upgrade, troubleshooting.
- `specs/001-enrahitu-architecture/spec.md`: the thesis and the phase plan.
- `specs/`: why every decision was made.
