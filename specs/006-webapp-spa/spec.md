---
id: "006-webapp-spa"
title: "Minimal Vue SPA served by the app itself"
status: approved
created: "2026-07-14"
implementation: complete
origin:
  retroactive: true   # phase 4 shipped before the spec graph existed
depends_on:
  - "005-rauthy-same-origin"
establishes:
  - { kind: directory, path: "webapp/" }
  - { kind: directory, path: "web/" }
summary: >
  The minimal frontend: a Vue 3 + Vite SPA (login, OIDC callback handoff,
  /me, logout) built from webapp/ into web/dist, and the `web` Encore
  service that serves the built bundle as static files from the app's own
  origin. No separate frontend host: the same container serves UI, API,
  and IdP.
---

# 006: Webapp SPA

## 1. Purpose

Prove the full authenticated loop end to end from a browser (login via
rauthy, session cookies, `/me`, logout) while keeping the single-origin,
single-container thesis: the app serves its own UI.

## 2. Territory

- `webapp/`: the Vue 3 + Vite source (own `package.json`, not a workspace
  member). `npm run build:web` at the root builds it into `web/dist`.
- `web/`: the Encore static service (`static.ts`, fallback route `/!path`)
  serving `web/dist`. Only the dev placeholder `web/dist/index.html` is
  tracked; real builds (hashed assets) are produced at build time and
  injected into the image by spec 007.

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
