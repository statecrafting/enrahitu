---
id: "017-idp-login-e2e"
title: "End-to-end rauthy login validation (browser-real)"
status: approved
created: "2026-07-14"
implementation: complete
depends_on:
  - "005-rauthy-same-origin"
  - "006-webapp-spa"
summary: >
  The rauthy driver's full browser round-trip (SPA -> same-origin /auth
  proxy -> rauthy login UI -> OIDC callback -> app session cookie) has
  been exercised by hand but never by an automated end-to-end test;
  this was the standing owed item from the enrahi phase close-out. This
  spec adds a Playwright-driven e2e that boots the app plus the dev
  rauthy (docker compose, spec 005), completes a real password login in
  a real browser engine, and asserts the session, profile, and logout
  behavior. Kept out of the default verify verb; runs as its own npm
  script and an optional scheduled CI job.
establishes:
  - { kind: directory, path: "e2e/" }
  - ".github/workflows/e2e.yml"
---

# 017: IdP login e2e

## 1. Purpose

Unit tests prove the token and cookie mechanics; nothing proves the
whole authentication topology (proxy path rewriting, rauthy redirects,
cookie scoping on one origin) survives change. One browser-real test
closes the highest-value gap in the template's confidence story,
especially before stamped apps put this flow in front of customers.

## 2. Territory

- `e2e/login.rauthy.spec.ts` (Playwright test) and `e2e/playwright.config.ts`.
- Root package.json gains `test:e2e` (playwright test) and the
  devDependency; vitest's include/exclude must not pick up `e2e/**`.

## 3. Behavior

- Setup: `npm run dev:idp` (compose rauthy + secret sync, spec 005),
  `npm run dev` (the app on :4000), both managed by Playwright's
  webServer config or a small globalSetup that starts and tears down.
- A test user is provisioned via rauthy's bootstrap/admin API (the dev
  compose already seeds an admin; the test creates or reuses a
  dedicated user with a known password; document the exact env keys the
  compose file expects).
- The test drives: open `/`, choose rauthy login, complete the rauthy
  form on the same origin (`/auth/v1/...`), land back authenticated,
  `/profile` shows the user's email via `GET /api/v1/auth/me`, logout
  clears the session (a subsequent /me returns 401), and no request in
  the trace ever left the app origin.
- Failure artifacts: Playwright trace + screenshot on failure, written
  under e2e/artifacts/ (gitignored).
- CI: not part of verify.yml. An `e2e.yml` workflow on
  `workflow_dispatch` + nightly schedule runs it on ubuntu (docker is
  available on hosted runners); flakes must fail loudly, not retry
  silently (`retries: 0`).

## 4. Acceptance

- `npm run test:e2e` passes locally from a clean checkout after
  `build:runtime`/`build:addon`/`build:app` (document the exact
  prerequisite commands in the test file header).
- Deliberately breaking the proxy (e.g. wrong issuer env) makes the
  test fail with a diagnosable trace, proving it actually exercises the
  topology.
- Spine gates green; vitest suite untouched and still 32/32.

## 5. Out of scope

- Load, MFA/passkey, and account-lifecycle flows (rauthy upstream owns
  its UI behavior).
- Running e2e inside the packaged container image (a later hardening
  spec may combine 016 + 017 into an image-level smoke).
