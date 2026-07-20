---
id: "004-auth-core"
title: "Auth service on CoreLedger + hiqlite rate limiting"
status: approved
created: "2026-07-14"
implementation: complete
origin:
  retroactive: true   # phase 2 shipped before the spec graph existed
depends_on:
  - "002-in-process-hiqlite"
  - "003-coreledger"
establishes:
  - { kind: directory, path: "backend/auth/" }
  - { kind: directory, path: "backend/lib/" }
  - "scripts/generate-keys.ts"
summary: >
  The authentication core, re-based from template-encore apps/api onto
  enrahitu's own substrate: stateless RS256 JWT access tokens in httpOnly
  cookies, rotated DB-backed refresh tokens, CSRF double-submit, roles, and
  audit records on CoreLedger; login rate limiting on hiqlite counters.
  Drivers are pluggable: mock (dev) here, rauthy OIDC in spec 005 (which
  owns backend/auth/rauthy.ts inside this spec's directory claim).
---

# 004: Auth core

## 1. Purpose

A complete, self-contained auth model with no managed dependencies: token
issuance and verification are stateless (RS256 keypairs), session revocation
is DB-backed (rotated refresh tokens on CoreLedger), and abuse is throttled
in-process (hiqlite counters). The reference implementation is
template-encore `apps/api`, ported off Encore `SQLDatabase`/Postgres.

## 2. Territory

- `backend/auth/`: the Encore service: driver discovery (`drivers.ts`,
  `GET /api/v1/auth/drivers|status|login`), the mock driver (`mock.ts`),
  refresh rotation (`refresh.ts`, `refresh-token-model.ts`), session
  surface (`me.ts`, `logout.ts`, `csrf-token.ts`), the auth handler
  (`handler.ts`), user persistence (`user-model.ts`, `entities.ts`,
  `store.ts`). `backend/auth/rauthy.ts` is the one file owned by spec 005.
- `backend/lib/`: the shared security library: `jwt.ts` (RS256 sign/verify),
  `cookies.ts` + `cookie-config.ts` (httpOnly cookie plumbing), `csrf.ts`
  (double-submit), `rate-limit.ts` + `rate-limit-window.ts` (hiqlite-backed
  windows), `roles.ts`, `audit.ts`, `security-headers.ts`, `env.ts`,
  `secrets.ts`, `logger.ts`.
- `scripts/generate-keys.ts`: dev keypair generation (`npm run
  generate-keys`) writing `keys/*.pem` (gitignored). In the container,
  first boot generates the same material (spec 007).

## 3. Behavior

- **Access tokens**: RS256 JWTs in httpOnly cookies; verification is
  stateless against the public key. `GET /api/v1/auth/status` reports
  cookie validity without ever returning 401.
- **Cookie security follows the public origin's scheme, not NODE_ENV**:
  cookies are `Secure` iff `FRONTEND_URL` is https. A production-mode
  container served over plain http (a local trial of the packaged image)
  must not mint Secure cookies: Safari drops them on http even for
  localhost, silently breaking login. Spec 007 applies the same rule to
  rauthy's session cookie via COOKIE_MODE.
- **Refresh tokens**: DB-backed on CoreLedger, rotated on every
  `POST /api/v1/auth/refresh`; reuse of a rotated token invalidates the
  family.
- **CSRF**: double-submit token via `GET /api/v1/auth/csrf-token`, enforced
  on mutating endpoints.
- **Rate limiting**: hiqlite counter windows around login and refresh.
- **Drivers**: a driver is listed only when its configuration is present
  (mock via env flag; rauthy when spec 005's config is set).
  `GET /api/v1/auth/login` redirects to the default driver.
- **Audit**: auth events append audit records on CoreLedger.

## 4. Out of scope

- The rauthy OIDC driver and everything same-origin-IdP: spec 005.
- MFA, WebAuthn, and account self-service: delegated to rauthy's own UI.
- Multi-tenancy and organization modeling.

## 5. Phase A seam (amended by spec 021, 2026-07-20)

Three hooks land in this spec's territory under the governance seam:
the secret accessors in `lib/secrets.ts` adjudicate `secret.read` of
their specific secret name before returning material; the rate limiter
consumes the governed hiq facade (its counter grants carry the
`keyPrefix: "rl:"` constraint, and every call passes its bucket key);
and the auth schema boot in `store.ts` runs inside a
`runAsService("auth", ...)` scope so its module-eval DDL is attributed
and adjudicated as `db.migrate`. Deny semantics follow the existing
typed-error convention (`APIError.permissionDenied` with a
`KERNEL_DENIED` detail code).
