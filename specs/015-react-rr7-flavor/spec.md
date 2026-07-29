---
id: "015-react-rr7-flavor"
title: "The member-facing SPA: React + React Router v7"
status: approved
created: "2026-07-14"
implementation: complete
depends_on:
  - "006-webapp-spa"
  - "014-scaffold-verb"
establishes:
  - { kind: directory, path: "frontend/" }
summary: >
  The application's one member-facing SPA: React 19 + React Router v7 in
  SPA/data-router mode on Vite, in frontend/, building into backend/web/dist
  for the web static service (spec 006) to serve same-origin. It was authored
  on 2026-07-14 as the second value of a frontend flavor slot; on 2026-07-29
  the React-only convergence (spec 001 section 4.3) retired the Vue flavor and
  the slot itself, promoted this source to frontend/, and made this the
  frontend spec rather than one of two. Contract v0.7 removes the slot, which
  is a breaking bump under a caret pin.
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

## 6. Status

**Completed 2026-07-15.** `frontend-react/` is the parallel flavor directory:
React 19 + React Router v7 in SPA/data-router mode (`createBrowserRouter`, no
SSR) + Vite 7, package `@enrahitu/frontend-react` (spec-spine manifest key here),
building into `backend/web/dist` exactly like the Vue flavor. Routes: `/`
(landing with login state), `/login` (driver choice, mock + rauthy), `/profile`
(GET /api/v1/auth/me, logout `Form` action, hiqlite cache demo widget). The API
client (`src/lib/api.ts`) copies the Vue flavor's with identical logic (only the
header comment differs): same same-origin cookie auth, silent-refresh retry, and
double-submit CSRF, so there is no flavor-specific auth path (§3).

Amended the owning specs in the same change: `template.toml` (spec 009) gained
`react-rr7` in `[slots].frontend.allowed` and bumped the contract to 0.5.0;
`scripts/stamp.mjs` (spec 014) gained the flavor-selection step (prune the
unselected flavor directory, repoint the root `build:web` / `dev:web` scripts at
the survivor) with three new `stamp.test.ts` cases; `spec-spine.toml` (spec 000)
gained `frontend-react` in `standalone_npm_packages`. The root `tsconfig.json`
and `vitest.config.ts` exclude `frontend-react/` alongside `frontend/` (the SPA
flavors typecheck and test under their own manifests, not the backend's).

Acceptance (§4) status:

- **react-rr7 stamped shape (§4 bullet 1): satisfied.** Built into
  `backend/web/dist` via the repointed `build:web`; served by `npm run dev` on
  :4000; the mock-driver login → profile (`/me`) → logout round-trip verified in
  a browser against the running app.
- **vue default (§4 bullet 2): satisfied.** `build:web` still builds the Vue
  flavor into `backend/web/dist`; the scaffold verb prunes `frontend-react/`
  from a vue stamp (stamp.test.ts), so the react directory is absent from the
  default stamped tree.
- **Spine gates in both stamped shapes + template (§4 bullet 3): satisfied.** A
  stamped shape with one flavor pruned stays green: an absent standalone package
  and an unimplemented `establishes` directory are index-render diagnostics, not
  `compile`/`index`/`lint --fail-on-warn` failures (verified empirically). The
  template repo carries both flavor directories and its full gauntlet
  (`typecheck`, `test`, `compile`, `index check`, `lint --fail-on-warn`,
  `couple`) is green.
- **Full image build + boot smoke: delegated.** Owned by the packaging pipeline
  (spec 007/008) and spec 016's amd64 work, as with spec 019's consumer-side
  acceptance; the flavor's only runtime footprint is the built `backend/web/dist`,
  which `docker-build.sh` already copies from `build:web` output.

**Amended 2026-07-15 (spec 013, Pages base path).** `frontend-react/vite.config.ts`
honors a `PAGES_BASE` env var as the Vite `base` (default `/`), and
`src/router.tsx` sets the `createBrowserRouter` `basename` to
`import.meta.env.BASE_URL`, so the React SPA works under a project Pages subpath
(`https://<owner>.github.io/<repo>/`) as well as at root. No effect on the
container or dev build, where `PAGES_BASE` is unset and `base` stays `/`.

**Amended 2026-07-23 (spec 005, RP-initiated logout).** The logout
action follows the server's `redirectUrl` with
`window.location.assign` instead of a client-side `redirect("/")`:
the end-session URL lives outside the SPA's route table, so a data
router redirect would 404 inside the app rather than reach rauthy.
Under the mock driver the URL is the frontend root and the visible
behavior is unchanged.

## Amendment (2026-07-29): the convergence, executed

Spec 001 §4.3 decided React-only on 2026-07-19 and left execution to "the
follow-up frontend spec", which was never authored. The divergence stood
for ten days across three surfaces that disagreed with each other: this
corpus said React-only, the tree carried both flavors, and `template.toml`
defaulted to `vue`. That is the exact failure the coupling gate exists to
prevent, and it survived because the decision named no owner.

Executed here:

- `frontend-react/` becomes `frontend/`, and this spec's `establishes`
  moves with it. The Vue source is deleted. Spec 006 keeps `backend/web/`,
  the serving contract, which never depended on the framework.
- The package is renamed `@enrahitu/frontend`.
- The `frontend` slot is removed from `template.toml` (contract v0.7, spec
  009) and the flavor-selection step is removed from the scaffold verb
  (spec 014). `--frontend` is still *recognized* by `stamp.mjs` and fails
  with a directed message naming the contract bump, so a factory that has
  not caught up learns what happened rather than getting a generic
  "unknown argument".
- The cache-demo widget is deleted, which is what allows the `hiq` HTTP
  surface to retire in the same change (spec 002).

**Why the slot went rather than becoming a one-value knob.** Spec 001 §4.3
left that open. The pivot closes it: enrahitu ships a working membership
application, not a shell to fill in, so the SPA carries the product's own
screens. There is no framework choice left to offer, and a slot with one
allowed value is not a knob, it is a lie about where the variation lives.
The extension seam is kinds and controllers (spec 001 §5.1 phase 4), not
a choice of view library.

**What this bought.** Every frontend change now costs one implementation
instead of two. CI installs one SPA package instead of two. The Encore
parse walk resolves one vite config instead of two, and the walk covers
the whole app root regardless of `tsconfig` excludes, so the second flavor
was parse cost on every build. And the application baseline (phase 5) gets
written once.
