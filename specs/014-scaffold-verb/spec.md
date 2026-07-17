---
id: "014-scaffold-verb"
title: "In-template scaffold verb + repoInit seeding (LI-4)"
status: approved
created: "2026-07-14"
implementation: complete
depends_on:
  - "009-template-contract"
  - "012-born-with-provenance"
establishes:
  - "scripts/stamp.mjs"
  - "scripts/stamp.test.ts"
summary: >
  Moves stamping logic from "factory-side folklore" into the template
  itself: a scaffold verb the factory (or a human) invokes inside a
  fresh clone of this repo to turn it into a named app. Slot
  substitution, lockfile discipline, registry regeneration, and
  certificate placement all live in one script with one contract entry.
  Absorption line item LI-4 of spec 010; fills the scaffold verb
  reserved by spec 009 §3.2 and bumps the contract to 0.4.0.
---

# 014: Scaffold verb

## 1. Purpose

The v0 stamping mode (spec 009: factory-side clone + substitution) was
proven manually on 2026-07-14 (statecrafting/enrahitu-stamp-smoke-1,
born green). The manual recipe had four steps that must not remain
tribal knowledge: substitute the app name in the manifest AND the
lockfile, regenerate the spec registry and codebase index, keep
platform-specific npm optionals intact, and place the provenance cert.
`scripts/stamp.mjs` encodes the recipe; `template.toml` exposes it.

## 2. Territory

- `scripts/stamp.mjs` (this spec).
- Amends `template.toml` (spec 009; edit both specs together): add
  `scaffold = "node scripts/stamp.mjs"` under `[verbs]`, bump
  `[contract].version` to `0.4.0` (0.3.0 was taken by spec 012's
  `[provenance]` table; the scaffold verb is the next minor).

## 3. Behavior

`node scripts/stamp.mjs --app-name <name> --org <org> [--frontend vue|react-rr7]
[--cert <path-to-born-with.json>] [--stamped-from <template-commit-sha>]`
run from the repo root of a fresh clone:

1. **Validate slots** against `template.toml [slots]` (name pattern
   `^[a-z][a-z0-9-]*$`, org required, frontend in the allowed list).
2. **Substitute app_name**: `package.json` root `"name"` and both
   `"name"` occurrences in `package-lock.json` (root field and the
   `packages[""]` entry). Substrate names (`@enrahitu/*`, the addon
   crate, env prefixes) are deliberately NOT touched: they are the
   chassis, not the app.
3. **Select frontend flavor** (spec 015): keep the selected flavor's
   directory and prune the rest (`vue → frontend/`,
   `react-rr7 → frontend-react/`), then repoint the root `build:web` /
   `dev:web` scripts at the survivor (`npm --prefix <dir> run build|dev`).
   The chassis carries every flavor directory; a stamped app ships exactly
   one. Idempotent: a re-run finds the unselected dirs already pruned and
   the scripts already repointed. The flavor→directory map lives in
   `stamp.mjs`; the allowed list lives in `template.toml` (spec 009); the
   two are amended together.
4. **Lockfile discipline**: if dependency edits ever become part of
   stamping, refresh with `npm install --package-lock-only` from the
   committed lock; never a full `npm install` on macOS, which prunes
   linux esbuild/rollup platform optionals and breaks `npm ci` on CI
   runners.
5. **Provenance**: when `--cert` is given, copy it to
   `.statecraft/born-with.json` and run
   `node scripts/verify-born-with.mjs` (spec 012); a failing cert fails
   the stamp.
6. **Regenerate derived truth**: `spec-spine compile && spec-spine index`
   (the app name is a hashed input; stale shards would fail the stamped
   repo's own spine gate). If the `spec-spine` binary is absent, fail
   with the install one-liner; do not skip.
7. **Detach lineage marker**: append a `## Stamped` section to README.md
   naming app, org, template commit, and date.
8. Print a summary and exit 0; any step failure exits non-zero with the
   failing step named. The script is idempotent: re-running with the
   same slots is a no-op that exits 0.

## 4. Acceptance

- A vitest suite for the script (child-process it against a temp copy of
  a minimal fixture tree) covers: happy path, invalid app name, lockfile
  name sync, idempotent re-run, failing cert.
- End-to-end: stamping a fresh clone with a test name leaves
  `npm ci && npm run typecheck && npm test` (the verify verb) green and
  `spec-spine index check` fresh, matching the manual smoke's result.
- Contract version reads 0.4.0; spine gates green.

## 5. Out of scope

- Creating GitHub repos, pushing, or org-side setup (factory, statecraft
  spec 005).
- Authoring new frontend flavors: each flavor directory is owned by its
  own spec (spec 015 added `frontend-react/`). The scaffold verb only
  selects among the flavors the chassis already carries: keep the chosen
  one, prune the rest, repoint `build:web` / `dev:web`.
- Cert *content* generation (factory-side; the script only places and
  validates).

## 6. Implementation notes

Landed 2026-07-15. `scripts/stamp.mjs` encodes the recipe; `template.toml`
exposes it as the `scaffold` verb and reads `[contract].version = "0.4.0"`.
Spec 009 (owner of `template.toml`) was amended in the same change to make
the reserved verb live.

Acceptance (§4) status:

- **Unit suite (§4 bullet 1): satisfied here.** `scripts/stamp.test.ts`
  child-processes the real CLI against a temp copy of a minimal fixture
  tree: happy path, invalid app name, missing org, disallowed frontend
  flavor, lockfile name sync (substrate names left intact), idempotent
  re-run (exactly one `## Stamped` section), and a failing cert (rejected
  and rolled back).
- **Contract + spine gates (§4 bullet 3): satisfied here.** Contract reads
  0.4.0; `compile`/`index`/`lint`/`couple` green.
- **Real-clone spine path (§4 bullet 2, in-repo half): exercised here.** A
  `git clone --local` of this repo, stamped with a test name, regenerates
  its derived truth (the app name is a hashed input) and leaves
  `spec-spine index check` fresh, matching the 2026-07-14 manual smoke.
- **Fresh-clone `npm ci` verify verb (§4 bullet 2, network half):
  delegated.** The born-green `npm ci && npm run typecheck && npm test` on a
  clean clone is owned by the first stamped consumer's CI (statecraft spec
  002) and the scaffold path the factory drives; running it here would
  reinstall the full dependency tree behind the network. A minimal
  design-time hazard: v0 stamping edits no dependencies, so the lockfile
  changes by exactly two `name` fields and the dependency graph is
  byte-identical to this repo's already-green tree.

**Amended 2026-07-15 (spec 015, contract v0.5).** The recipe gained step 3,
frontend flavor selection: the scaffold verb now prunes the unselected flavor
directories (`vue → frontend/`, `react-rr7 → frontend-react/`) and repoints the
root `build:web` / `dev:web` scripts at the survivor. `scripts/stamp.test.ts`
gained three cases (react-rr7 prunes the vue dir and repoints the scripts; vue
default prunes the react dir; re-stamp idempotent). A pruned flavor left in
`spec-spine.toml`'s standalone list or a spec's `establishes` directory is
benign: an absent standalone package and an unimplemented `establishes` unit
are index-render diagnostics, not `compile`/`index`/`lint` failures, so the
stamped app's spine gates stay green without the stamp editing governance
files. Verified empirically before the change.
