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

## 5. Phase A seam (amended by spec 021, 2026-07-20)

The proxy's upstream `fetch` moves behind spec 021's governed egress
facade: each proxied request adjudicates `http.egress` on resource
`rauthy-upstream` (attribute: the target hostname) before leaving the
process, and a deny answers 403 in the proxy's own raw-response style.
The OIDC driver's two outbound round-trips (discovery, code grant)
adjudicate `http.egress` on resource `rauthy-issuer` at the call site;
the issuer host itself stays runtime config and never enters the model
(spec 020 determinism rules).

## 6. Observability seam (amended by spec 022, 2026-07-22)

The idp service mounts spec 022's `obsMiddleware` (its only
middleware): the `/auth/*` passthrough gets a request span and rides
the request metrics as service `idp`, endpoint `proxy`, a static
label pair. The deliberate no-auth-middlewares posture is unchanged:
observation adds no session, CSRF, or header behavior, and rauthy
still manages its own.

With observation mounted, the proxy handler awaits the response-body
pipe (`stream/promises.pipeline`) instead of resolving at pipe start:
the span and duration histogram measure the flushed response, and a
mid-stream upstream failure rejects into the handler (response
destroyed) rather than leaking an unhandled stream error.

## Amendment (2026-07-23): RP-initiated logout (the id-hint cookie)

App sign-out ended only the app session: rauthy's own session cookie
survived the logout, so the next login silently re-authenticated
without credentials. Fixed with OIDC RP-initiated logout, same-origin
like everything else in this spec:

- **The hint rides the browser, not the store.** The callback keeps
  `tokens.id_token` in an `oidc_id_hint` cookie: httpOnly, path-scoped
  to `/api/v1/auth`, lifetime equal to the refresh session
  (`REFRESH_TOKEN_MAX_AGE`). The design fork (cookie vs a column on
  the refresh-token row) resolves to the cookie deliberately: the
  refresh-token store is hash-only by design (spec 004) and stays free
  of identity assertions at rest; token rotation needs no carry
  plumbing; and the hint returns to the only place it is ever needed,
  the browser's own logout round-trip. The cost is cookie weight on
  `/api/v1/auth/*` requests only (path-scoped), roughly one RS256
  id token.
- **Logout returns the end-session URL.** When the driver is
  configured and the hint cookie is present, spec 004's
  `POST /api/v1/auth/logout` answers `redirectUrl` =
  `<issuer>oidc/logout` with `id_token_hint` and
  `post_logout_redirect_uri` = the frontend root, same-origin through
  the idp proxy (`rauthyEndSessionUrl` in `backend/auth/rauthy.ts`,
  which tolerates a missing issuer trailing slash). The SPA navigates
  there; rauthy ends its session and redirects back to the registered
  root. Absent hint or driver, `redirectUrl` stays the frontend root:
  the mock driver's behavior is byte-identical to before.
- **Registration already existed.** Both client bootstraps have
  carried `post_logout_redirect_uris = ["<public-url>/"]` since spec
  007's first boot; the dev bootstrap additionally registers the Vite
  origin (`http://localhost:5173/`) so a hot-dev logout round-trip is
  legal too.
- **Proofs.** `backend/auth/rauthy-logout.test.ts` (in spec 004's
  directory claim, riding this amendment) pins the end-session URL
  shape and the hint cookie's path scoping; spec 017's e2e asserts the
  wire fact against real rauthy.

## Amendment (2026-07-25): the proxy forwards only vouched values (spec 025)

`forwardHeaders` appended the socket address to whatever
`X-Forwarded-For` the client supplied and sent the concatenation
upstream. rauthy trusts that chain under `TRUSTED_PROXIES=127.0.0.0/8`,
so its own IP-based defenses inherited any forgery a caller invented.

The header is now rebuilt from the resolved client identity
(`vouchedForwardedFor`, spec 025 §3.2): the entry this app actually
vouches for, followed by this hop. Client-supplied entries the declared
topology does not cover are dropped rather than forwarded. The
same-origin invariant, the hop-by-hop stripping, the manual redirect
policy, and the body-streaming shape are unchanged.

## Amendment (2026-08-03): the dev client's token lifetime (spec 004)

`docker/rauthy/bootstrap/clients.json` drops `access_token_lifetime` from 1800
to 60, and the reason is a property of rauthy worth stating here because it
constrains every consumer.

rauthy stamps a refresh token with `nbf = issued + access_token_lifetime - 60`,
so it cannot be used until sixty seconds before its access token expires. At
1800 the login e2e could only have exercised a renewal after idling for
29 minutes, which means renewal was in practice untested; at 60 the window opens
immediately and the dev loop renews every minute, which is where a renewal bug
should surface rather than in somebody's production.

This is a development value. A deployment sets whatever lifetime it wants on its
own client, and the app follows it (spec 004 §3.4): the session's lifetime is the
authority's, for the same reason its subject is.

RP-initiated logout gains weight in the same change. With no local session
record left to revoke, clearing the cookies discards the only copy of the refresh
token the app held, and this spec's end-session redirect is what actually ends
the session at rauthy. It is no longer a courtesy.
