---
id: "013-pages-deploy-slot"
title: "GitHub Pages deployment slot (LI-3)"
status: approved
created: "2026-07-14"
implementation: complete
depends_on:
  - "010-template-encore-absorption"
establishes:
  - ".github/workflows/pages.yml"
summary: >
  An optional, off-by-default GitHub Pages workflow that stamped apps are
  born with: it publishes the built SPA (backend/web/dist) as a static preview
  site when the repo owner enables Pages. Absorption line item LI-3 of
  spec 010. Not a contract verb: it is CI-side, not factory-side. The
  workflow must be inert (skip cleanly, not fail) in repos where Pages
  is disabled, which is the default posture.
---

# 013: Pages deployment slot

## 1. Purpose

Stamped apps often want a zero-cost static preview of their SPA without
standing up the container. GitHub Pages provides it; the template
provides the workflow so the capability is born-with rather than
hand-rolled per repo.

## 2. Territory

`.github/workflows/pages.yml` only. No template.toml change: Pages is
not part of the factory contract (spec 009 §Out of scope holds).

## 3. Behavior

- Triggers: `workflow_dispatch` always; `push` to `main` only when the
  repo variable `ENABLE_PAGES` is `"true"` (job-level
  `if: github.event_name == 'workflow_dispatch' || vars.ENABLE_PAGES == 'true'`).
  Default posture (variable unset) means push events skip the job.
- Steps: checkout, setup-node 24 (npm cache), `npm --prefix frontend ci`,
  `npm run build:web`, upload `backend/web/dist` via `actions/upload-pages-artifact`,
  deploy via `actions/deploy-pages` with the standard
  `pages: write` + `id-token: write` permissions and the `github-pages`
  environment.
- All actions SHA-pinned with a trailing `# vX.Y.Z` comment, matching
  `verify.yml` house style.
- **Project-site base path (amended 2026-07-15)**: a project Pages site serves
  at `https://<owner>.github.io/<repo>/`, so the build sets `PAGES_BASE` to
  `/<repo>/` (overridable by a `PAGES_BASE` repo variable, set to `/` for a
  user/org site or a custom domain). Each frontend flavor's `vite.config.ts`
  reads it as the Vite `base` (specs 006/015); the React flavor also feeds it to
  the router `basename` via `import.meta.env.BASE_URL` (spec 015). The build then
  copies `index.html` to `404.html` so client-side deep links resolve through the
  SPA router instead of a Pages 404. The container and dev builds leave
  `PAGES_BASE` unset, so `base` stays `/` and the image is unaffected.
- **Flavor-agnostic build (amended 2026-07-15)**: the workflow resolves and
  builds whichever frontend flavor directory the stamped app kept (`frontend/`
  or `frontend-react/`), since a stamped app carries exactly one (spec 015),
  rather than a hardcoded `frontend/`. The chassis, carrying both, builds the
  Vue default.
- **The needs-guard rule (hard requirement)**: if the workflow gains a
  dependent job (e.g. build then deploy), the dependent job's `if` MUST
  re-assert `needs.<job>.result == 'success'` whenever any custom
  job-level `if` is present. A custom `if` silently replaces the
  implicit success() guard, letting deploy run after a failed build;
  this exact bug shipped once in the template-encore era and is the
  reason this rule is written down.

## 4. Acceptance

- On a repo with Pages disabled and no `ENABLE_PAGES` variable, a push
  to main leaves the workflow skipped (not failed).
- `workflow_dispatch` on this repo (enable Pages on the repo first, or
  document the manual toggle in the workflow header comment) publishes
  backend/web/dist and the resulting URL serves the SPA placeholder.
- actionlint (or `gh workflow view` syntax acceptance) passes; spine
  gates stay green (the index hashes workflow files).
- A Pages build with `PAGES_BASE=/<repo>/` emits asset URLs under `/<repo>/`
  for both flavors and writes a `404.html`; an unset `PAGES_BASE` builds at base
  `/`, matching the container build.
- A react-stamped app (only `frontend-react/` present) builds cleanly: the
  workflow resolves the surviving flavor directory rather than a hardcoded
  `frontend/`.

## 5. Out of scope

- Publishing docs sites (that is stagecraft.ing's concern).
- Custom domains for stamped apps.
- Any coupling to the factory contract or verify verb.

## 6. Amendment (2026-07-15): project-site base path + flavor-agnostic build

The original workflow served correctly only from a user/org Pages site or a
custom domain (Vite `base` defaulted to `/`), and hardcoded the `frontend/`
(Vue) flavor. Two additions, both inside pages.yml territory plus the flavor
configs their owning specs govern:

1. **Project base path.** The build sets `PAGES_BASE` (default `/<repo>/`,
   overridable via the `PAGES_BASE` repo variable) so a project Pages site
   (`https://<owner>.github.io/<repo>/`) loads its hashed assets. The flavor
   `vite.config.ts` files consume it as `base` (specs 006/015) and the React
   router reads it as `basename` (spec 015); a `404.html` copy of `index.html`
   gives client-side deep links an SPA fallback. The container and dev builds
   leave `PAGES_BASE` unset, so nothing about the image changes.
2. **Flavor-agnostic.** The install and build steps resolve the surviving
   flavor directory instead of assuming `frontend/`, so a react-stamped app's
   Pages build works (it prunes `frontend/`, keeping `frontend-react/`; spec
   015).

Still out of the factory contract (no `template.toml` change): Pages remains a
born-with CI capability, off by default. Owning-spec edits coupled in the same
change: 006 (`frontend/vite.config.ts`) and 015 (`frontend-react/`).
