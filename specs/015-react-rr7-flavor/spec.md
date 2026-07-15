---
id: "015-react-rr7-flavor"
title: "Second frontend flavor: React + React Router v7"
status: approved
created: "2026-07-14"
implementation: complete
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
