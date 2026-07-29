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
  the only template the Statecraft factory stamps. LI-1 done
  2026-07-14 (born-green stamp proven); each item flips to done
  individually.
---

# 010: template-encore absorption

## 1. Purpose

The consolidation decision (2026-07-14) makes enrahitu the single template
chassis. "Everything template-encore provides can be absorbed" is true but
not free; this spec is the ledger of what must actually move, so nothing
transfers by assumption and nothing is silently dropped. Provenance:
knowledge://statecrafting/template-encore and OAP specs 197/198/199
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
  workflow installs every frontend flavor's deps (`npm --prefix frontend ci`
  and `npm --prefix frontend-react ci`, npm cache on both flavor lockfiles):
  the template carries every flavor (spec 015) and the Encore parse walk
  (`build:app`) resolves each flavor's `vite.config` imports, so both must be
  present in CI. A stamped app keeps only the selected flavor (the scaffold
  verb prunes the rest), so its CI installs just the survivor. The flavor
  directory names track the spec 019 two-directory rename from `webapp/` to
  `frontend/`. The verify job also runs a digest-pinned
  Postgres service and passes `TEST_POSTGRES_URL` to the verify verb so
  CoreLedger's Postgres-driver arm (spec 011) is exercised on every run
  alongside the libSQL default; the service is CI-side only and stays out
  of the stamped runtime.
  Born-green proof: statecrafting/enrahitu-stamp-smoke-1, a manual v0
  stamp (spec 009 §3.2 factory-side mode: app_name slot into
  package.json + lockfile, registry/index regenerated), whose verify
  run 29369367571 succeeded on its initial commit with no repo-local
  changes. The smoke repo is kept public as evidence.
- **Amendment (spec 021, 2026-07-20)**: the verify workflow gains the
  app-model staleness gate after the app build (`enrahitu-extract
  --check`, exit 2 on a committed model that no longer matches
  recomputation), so the governed derived artifact of spec 021 rides
  the same born-green gate a stamped app inherits.

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

- **Source**: statecraft `repoInit.ts` seed + template-encore's produced
  repo dependency discipline.
- **Target**: the in-template `scaffold` verb (spec 009 §3.2 reserved).
  Seeding rules that must survive the move: produced-repo dependencies
  come from the template seed, and lockfile refresh uses
  `npm install --package-lock-only` from the committed lock so
  platform-specific optionals (esbuild/rollup) are not pruned on macOS.

## 4. Out of scope

- Retiring template-encore's Git history (the repo is archived, not
  deleted; its history remains the provenance record).
- factory-side stamping changes (owned by statecraft's factory spec).
- Any new capability that template-encore did not already have.

Amended by spec 023 (2026-07-22): the verify workflow installs the
`frontend-admin/` package alongside the two frontend flavors (parse-walk
resolution, same as spec 015's flavor installs) and caches its lockfile.

## Amendment (2026-07-27): the license boundary runs in verify (spec 001)

`verify.yml` (this spec's territory) gains a `npm run check:licenses` step
immediately after `npm ci`, enforcing the AGPL boundary that spec 001 §4.7
states: customer-reaching packages never depend on AGPL-licensed ones, so
`@statecrafting/governance-native` (AGPL-3.0) must never appear in this
repo's dependency graph while `@statecrafting/kernel-native` (Apache-2.0)
is the sanctioned path for admission and audit.

Two placement decisions, both deliberate. It runs **in this repo** because
this repo's `package.json` is where such a dependency would be declared,
and a guard living only upstream does not gate these PRs. It runs
**before the build**, because its whole job is to refuse a dependency
graph, and the cheapest moment to learn the graph is wrong is before
anything compiles against it.

The guard itself (`scripts/check-licenses.mjs` and its test) is spec 001's
territory, since the rule it enforces is stated there. This amendment
covers only the workflow step.

Not yet decided: whether the check joins `template.toml [verbs].verify`,
which would make every stamped app inherit it. That touches the template
contract, so it rides the phase 1c change that already bumps the contract
version (spec 001 §5.1) rather than bumping it twice.

## Amendment (2026-07-29): one frontend install in verify

`verify.yml` (this spec's territory) drops `npm --prefix frontend-react ci`
and the second lockfile cache path. The chassis carried both flavor
packages because the Encore parse walk resolves every flavor's
`vite.config` import regardless of `tsconfig` excludes, so both had to be
installed for `build:app` to succeed. With the flavor slot retired
(spec 015, contract v0.7) there is one SPA package, so the install that
existed to satisfy the parse walk goes with it.

The `frontend-admin` install stays: the dashboard is a real optional slot
(spec 023) and its config is still in the walk.

## Amendment (2026-07-29): the infra-config drift gate (spec 033)

`verify.yml` gains `npm run check:infra` beside the license check. The
`infra.config.*.json` files are now generated from one declarative source
(spec 033 §3.4) rather than hand-maintained as twins that must agree, and
this step fails the PR when a committed file differs from its regeneration.

It sits next to `check:licenses` and before the build for the same reason:
both refuse a configuration, and the cheapest moment to learn a configuration
is wrong is before anything is built against it. A hand-edit to a generated
config is otherwise discovered at boot, in an environment nobody develops in,
which is precisely the failure mode that generating them exists to end.

## Amendment (2026-07-29b): the chassis boundary gates (spec 035)

`verify.yml` gains two checks, both alongside the infra-config drift gate and
for the same reason: a generated file that has been hand-edited is a
disagreement between authored intent and what actually runs, and the cheapest
place to find it is the pull request.

- **`check:manifest`.** `app-manifest.json` is now composed from
  `app-manifest.chassis.json` and `app/manifest.json` (spec 035 §3.3). A
  hand-edit to the derived file would be a capability that exists in the model,
  and therefore in the kernel's enforced ceiling, and in nobody's authored
  intent. It is caught here rather than at adjudication, where it would look
  like a grant somebody meant to make.
- **`check:chassis`.** `chassis.lock` is what lets a stamped deployment tell an
  edited chassis file from an untouched one before it takes an upgrade (spec
  035 §3.2). In *this* repository every chassis change is legitimate and the
  lock simply has to keep up, so the gate here is staleness. Shipping a stale
  lock would misreport a downstream deployment's local edits, which is worse
  than not shipping one: it would report a file as safe to overwrite when the
  deployment had changed it.

Both run before the app build, like the license and infra gates, because they
read files off disk and depend on nothing being compiled first.
