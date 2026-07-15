---
id: "015-react-rr7-flavor"
title: "Second frontend flavor: React + React Router v7"
status: approved
created: "2026-07-14"
implementation: pending
depends_on:
  - "006-webapp-spa"
  - "014-scaffold-verb"
establishes:
  - { kind: directory, path: "frontend-react/" }
summary: >
  Makes the frontend slot real by adding a second allowed value:
  react-rr7. A parallel SPA source directory (frontend-react/, React 19 +
  React Router v7 in SPA/data-router mode + Vite) builds into the same
  backend/web/dist that the web static service serves, hitting the same auth and
  API endpoints as the Vue SPA (spec 006). The scaffold verb selects the
  flavor at stamp time; the chassis never ships both to a stamped app.
---

# 015: React + RR7 frontend flavor

## 1. Purpose

The frontend is a slot, not a fork (spec 009 §3.1). Vue shipped first
because it existed; React + React Router v7 is the second flavor because
it is the most commonly requested agency stack. Each flavor is a
directory the scaffold verb keeps or prunes; nothing else in the chassis
may vary by flavor.

## 2. Territory

`frontend-react/`: its own package.json (`@enrahitu/frontend-react`,
spec-spine manifest key pointing here), vite.config.ts, tsconfig, src/. It
is the parallel flavor directory to spec 019's `frontend/` (the Vue flavor),
both siblings at the repo root under the two-directory layout.
Amends at implementation time (edit the owning specs together):
`template.toml` `[slots].frontend.allowed` gains "react-rr7" (contract
minor bump), `scripts/stamp.mjs` (spec 014) prunes the unselected
flavor directory and rewrites the root `build:web` / `dev:web` scripts
to point at the chosen one, and `spec-spine.toml`
`standalone_npm_packages` gains the new package.

## 3. Behavior

Feature parity with the Vue SPA (spec 006), which is the reference:

- Routes: `/` (landing with login state), `/login` (driver choice:
  mock or rauthy), `/profile` (shows `GET /api/v1/auth/me`), logout
  action, plus the hiqlite cache demo widget.
- Auth flows through the same endpoints and cookies as spec 004/005;
  no flavor-specific auth code paths. CSRF header handling matches the
  Vue implementation.
- React Router v7 in SPA mode (createBrowserRouter data router); no
  SSR, no framework-mode server bundle: the chassis serves static
  files from backend/web/dist via the web service, and that stays true.
- `npm --prefix frontend-react run build` outputs to `backend/web/dist`
  exactly like the Vue build; the built artifact is indistinguishable to
  the server.

## 4. Acceptance

- With frontend=react-rr7 stamped: `npm run build:web` produces
  backend/web/dist, `npm run dev` serves it, login (mock driver) + profile +
  logout round-trip works in a browser.
- With frontend=vue (default): behavior identical to today; the react
  directory is absent from the stamped tree.
- The verify verb and spine gates stay green in both stamped shapes and
  in the template repo itself (which carries both directories).

## 5. Out of scope

- Svelte (earns a slot on demand, later spec).
- SSR/framework-mode React Router.
- Any divergence in auth, API, or packaging between flavors.
