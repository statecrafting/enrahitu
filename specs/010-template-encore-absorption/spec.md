---
id: "010-template-encore-absorption"
title: "Absorb template-encore's remaining value, then retire it"
status: approved
created: "2026-07-14"
implementation: in-progress
depends_on:
  - "009-template-contract"
establishes:
  - ".github/workflows/verify.yml"
summary: >
  template-encore (the previous chassis, stamped by factory-encore) still
  owns four capabilities this template does not have: born-green CI
  workflows, the born-with certificate + agentic posture flow, Pages
  deployment, and repoInit seeding. This spec enumerates the absorption
  line items with their source locations and target shapes. When all four
  land here, template-encore retires as a chassis and the enrahitu repo is
  the only template the Stagecraft factory stamps. LI-1 done
  2026-07-14 (born-green stamp proven); each item flips to done
  individually.
---

# 010: template-encore absorption

## 1. Purpose

The consolidation decision (2026-07-14) makes enrahitu the single template
chassis. "Everything template-encore provides can be absorbed" is true but
not free; this spec is the ledger of what must actually move, so nothing
transfers by assumption and nothing is silently dropped. Provenance:
knowledge://stagecraft-ing/template-encore and OAP specs 197/198/199
(factory dependency swap), 203/210/220 (certification lineage).

## 2. Territory

No units yet. Each line item, as it lands, adds its `establishes:` edges
here or graduates into its own spec if it grows past a section.

## 3. Line items

Each line item's design now lives in its own implementing spec: LI-2 is
spec 012, LI-3 is spec 013, LI-4 is spec 014. This ledger tracks
completion; the implementing specs own the how.

### LI-1: Born-green CI workflows

- **Source**: template-encore `.github/workflows/` (lint, typecheck, test,
  build; SHA-pinned actions).
- **Target**: workflow templates in this repo that a stamped app is born
  with, wired to the contract's `verify` verb (spec 009 §3.2) so CI and
  factory verification run the same gate. Actions stay SHA-pinned.
- **Note**: the dependent-job guard lesson from template-encore #43
  applies: never let a custom job-level `if` override the implicit
  success() needs-guard.
- **Status**: DONE 2026-07-14. This repo's own CI runs the contract's
  verify verb (`.github/workflows/verify.yml`, owned here) alongside
  the spec-spine governance gate (`.github/workflows/spec-spine.yml`).
  Because stamping is a tracked-tree copy, these same workflows ARE the
  born-with set: no separate per-repo copy step exists to drift. The
  workflow's SPA dependency path (`npm --prefix frontend ci`, npm cache on
  `frontend/package-lock.json`) tracks the spec 019 two-directory rename
  from `webapp/` to `frontend/`. The verify job also runs a digest-pinned
  Postgres service and passes `TEST_POSTGRES_URL` to the verify verb so
  CoreLedger's Postgres-driver arm (spec 011) is exercised on every run
  alongside the libSQL default; the service is CI-side only and stays out
  of the stamped runtime.
  Born-green proof: stagecraft-ing/enrahitu-stamp-smoke-1, a manual v0
  stamp (spec 009 §3.2 factory-side mode: app_name slot into
  package.json + lockfile, registry/index regenerated), whose verify
  run 29369367571 succeeded on its initial commit with no repo-local
  changes. The smoke repo is kept public as evidence.

### LI-2: Born-with certificate + agentic posture

- **Source**: template-encore cert flow; OAP specs 203 (certification),
  210 (agentic posture binding), 220 (born-with lockstep); tenant-emit /
  tenant-tail consume the emitted stream.
- **Target**: stamp-time provenance binding behind the reserved
  `[provenance]` contract table (spec 009 §3.3). The stamped repo is born
  with a certificate that binds its agenticPostureBinding explicitly
  (never defaulted).
- **Contract impact**: minor bump when the table lands.

### LI-3: Pages deployment

- **Source**: template-encore Pages workflow (including the #43 fix).
- **Target**: an optional workflow slot in the stamped repo; off unless
  the org enables Pages. Not a contract verb (it is CI-side, not
  factory-side).

### LI-4: repoInit seeding

- **Source**: stagecraft `repoInit.ts` seed + template-encore's produced
  repo dependency discipline.
- **Target**: the in-template `scaffold` verb (spec 009 §3.2 reserved).
  Seeding rules that must survive the move: produced-repo dependencies
  come from the template seed, and lockfile refresh uses
  `npm install --package-lock-only` from the committed lock so
  platform-specific optionals (esbuild/rollup) are not pruned on macOS.

## 4. Out of scope

- Retiring template-encore's Git history (the repo is archived, not
  deleted; its history remains the provenance record).
- factory-side stamping changes (owned by stagecraft's factory spec).
- Any new capability that template-encore did not already have.
