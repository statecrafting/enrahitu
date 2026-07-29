---
id: "006-webapp-spa"
title: "The web service: the app serves its own SPA"
status: approved
created: "2026-07-14"
implementation: complete
origin:
  retroactive: true   # phase 4 shipped before the spec graph existed
depends_on:
  - "005-rauthy-same-origin"
establishes:
  - { kind: directory, path: "backend/web/" }
summary: >
  The `web` Encore service: it serves the built SPA bundle as static files
  from the app's own origin, so one container serves UI, API, and IdP with
  no separate frontend host. This spec originally also owned the SPA source
  (a Vue 3 + Vite app in frontend/); that source retired with the React-only
  convergence on 2026-07-29 and the surviving SPA is spec 015's. What stays
  here is the serving contract, which never depended on the framework that
  produced the bundle.
---

# 006: Webapp SPA

## 1. Purpose

Prove the full authenticated loop end to end from a browser (login via
rauthy, session cookies, `/me`, logout) while keeping the single-origin,
single-container thesis: the app serves its own UI.

## 2. Territory

- `frontend/`: the Vue 3 + Vite source (own `package.json`, not a workspace
  member). `npm run build:web` at the root builds it into `backend/web/dist`.
  Spec 019 renamed this directory from `webapp/` to `frontend/`; the package
  is `@enrahitu/frontend`. `vite.config.ts` honors a `PAGES_BASE` env var as the
  Vite `base` (default `/`) so the GitHub Pages workflow (spec 013) can serve
  the SPA from a project subpath without affecting the container or dev build.
- `backend/web/`: the Encore static service (`static.ts`, fallback route
  `/!path`) serving `backend/web/dist`. Only the dev placeholder
  `backend/web/dist/index.html` is tracked; real builds (hashed assets) are
  produced at build time and injected into the image by spec 007.

## 3. Behavior

- The SPA drives spec 004/005's endpoints: driver discovery, login redirect,
  the OIDC callback landing, `GET /api/v1/auth/me`, `POST
  /api/v1/auth/logout`; auth state travels in httpOnly cookies, so the SPA
  holds no tokens.
- The static service is the lowest-precedence route: API and `/auth/*`
  paths win; everything else falls through to the SPA bundle.

## 4. Out of scope

- Any product UI beyond the auth loop.
- SSR, routing frameworks, state management libraries.
- An interactive rauthy password-login browser click-through remains owed
  from phase 4 verification (rauthy's PoW-gated login form resists headless
  testing); tracked as a verification gap, not a code gap.

## Amendment (2026-07-22): dist-admin joins the web directory (spec 023)

`backend/web/` carries a second built-bundle directory,
`backend/web/dist-admin/` (the operator dashboard, built by
`npm run build:web-admin` from `frontend-admin/`), tracked as a dev
placeholder only, exactly like `dist/`. The web service itself does not
serve it: `backend/admin/` streams it behind the operator-role gate
(spec 023 §3.2); the `/!path` fallback and the SPA's own serving are
unchanged.

## Amendment (2026-07-23): logout follows redirectUrl (spec 005)

The SPA's sign-out follows the server's answer: `logout()` in
`src/lib/api.ts` returns the response's `redirectUrl` and the app
navigates there with `window.location.assign`, completing rauthy's
RP-initiated logout round-trip (spec 005). Under the mock driver the
URL is the frontend root, so the visible behavior is a plain reload
into the signed-out state.

## Amendment (2026-07-29): the SPA source leaves, the service stays

This spec was authored around a Vue 3 SPA and the `web` service that
serves it. The React-only convergence (spec 001 §4.3, executed in spec
015) deletes the Vue source, so this spec gives up `frontend/` and keeps
`backend/web/`.

The split is not arbitrary. The `web` service serves static files out of
`backend/web/dist` and has never known what produced them: the bundle is
built by whichever SPA package writes to that directory, and the service's
contract (same-origin serving, SPA fallback routing, the container
carrying `dist/` in the image) is unchanged by the framework swap. That
independence is why the convergence is a directory move rather than a
rewrite of this spec's behavior.

Nothing in sections 1 through 4 describing the serving behavior is
amended. What retires is this spec's claim on the SPA source, which now
belongs to spec 015.
