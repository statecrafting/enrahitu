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

## 5. Out of scope

- Publishing docs sites (that is stagecraft.ing's concern).
- Custom domains for stamped apps.
- Any coupling to the factory contract or verify verb.
