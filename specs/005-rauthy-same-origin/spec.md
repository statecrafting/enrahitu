---
id: "005-rauthy-same-origin"
title: "rauthy behind a same-origin proxy + OIDC driver"
status: approved
created: "2026-07-14"
implementation: complete
origin:
  retroactive: true   # phase 3 shipped before the spec graph existed
depends_on:
  - "004-auth-core"
establishes:
  - { kind: directory, path: "backend/idp/" }
  - "backend/auth/rauthy.ts"
  - { kind: directory, path: "docker/rauthy/" }
  - "docker/compose.dev.yml"
  - "scripts/sync-dev-rauthy-secret.mjs"
summary: >
  rauthy as the OIDC IdP, reached exclusively through the app's own origin:
  the idp service mounts /auth/* as a raw passthrough proxy onto rauthy
  (RAUTHY_UPSTREAM, default 127.0.0.1:8081), so issuer, callback, and SPA
  share one origin with no CORS. backend/auth/rauthy.ts is the OIDC
  authorization-code + PKCE driver (login redirect + callback) plugged into
  spec 004's driver registry. Dev runs rauthy via docker compose with the
  same declarative client bootstrap the container uses in prod.
---

# 005: rauthy behind a same-origin proxy

## 1. Purpose

One public origin for app and IdP (ARCHITECTURE.md Key decision 4): the
issuer, the authorize/callback endpoints, and the SPA all live on the app's
origin, so there is exactly one exposed port and no CORS between app and
IdP. Fallback (not taken): exposing rauthy on a second port.

## 2. Territory

- `backend/idp/`: the passthrough proxy service, `ANY /auth/*rest` onto
  `RAUTHY_UPSTREAM` (default `http://127.0.0.1:8081`).
- `backend/auth/rauthy.ts`: the OIDC driver inside spec 004's `backend/auth/`
  directory claim: `GET /api/v1/auth/rauthy/login` (302 to the same-origin
  authorize
  URL, `code_challenge_method=S256`) and `GET /api/v1/auth/rauthy/callback`
  (code exchange, user upsert, cookie issuance via spec 004's machinery).
  `isRauthyConfigured()` gates the driver's presence in driver discovery.
- `docker/rauthy/`: rauthy configuration: `config.toml` (dev),
  `config.prod.toml` (baked into the image by spec 007), and `bootstrap/`
  (the declarative client bootstrap template).
- `docker/compose.dev.yml`: dev rauthy container.
- `scripts/sync-dev-rauthy-secret.mjs`: syncs the dev client secret between
  the rauthy bootstrap and the app's env.

## 3. Behavior

- The proxy is raw and unfiltered for the `/auth/*` subtree; rauthy binds
  loopback only in the packaged container (spec 007), so the proxy is the
  sole route in.
- Request bodies are forwarded as a web stream via
  `Readable.toWeb(Readable.from(req))`: the re-wrap is load-bearing, because
  Encore's RawRequest exposes a non-EventEmitter `.req` that node's
  end-of-stream cleanup would otherwise call `removeListener` on, crashing
  the process on the first body-bearing proxy request (and, in the
  container, taking rauthy down with it via die-together supervision).
  Streaming bodies through undici's fetch also requires `duplex: "half"`
  (typed since @types/node 26; no suppression directive).
- The client bootstrap (id `enrahitu`) declares the authorization-code +
  refresh-token flows, S256 PKCE, RS256 tokens, and redirect URIs derived
  from the public URL. rauthy applies it only while its database is
  uninitialized, so re-writing it on boot is harmless.
- The driver trusts rauthy's discovery document fetched via
  `RAUTHY_ISSUER` (same-origin in prod: `<public-url>/auth/v1/`).

## 4. Out of scope

- rauthy's own runtime supervision, secret generation, and loopback binding
  in the container: spec 007.
- Upstream identity federation (rauthy's own upstream providers).
- The SPA login UX: spec 006.
