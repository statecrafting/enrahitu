---
id: "014-scaffold-verb"
title: "In-template scaffold verb + repoInit seeding (LI-4)"
status: approved
created: "2026-07-14"
implementation: pending
depends_on:
  - "009-template-contract"
  - "012-born-with-provenance"
establishes:
  - "scripts/stamp.mjs"
summary: >
  Moves stamping logic from "factory-side folklore" into the template
  itself: a scaffold verb the factory (or a human) invokes inside a
  fresh clone of this repo to turn it into a named app. Slot
  substitution, lockfile discipline, registry regeneration, and
  certificate placement all live in one script with one contract entry.
  Absorption line item LI-4 of spec 010; fills the scaffold verb
  reserved by spec 009 §3.2 and bumps the contract to 0.3.0.
---

# 014: Scaffold verb

## 1. Purpose

The v0 stamping mode (spec 009: factory-side clone + substitution) was
proven manually on 2026-07-14 (stagecraft-ing/enrahitu-stamp-smoke-1,
born green). The manual recipe had four steps that must not remain
tribal knowledge: substitute the app name in the manifest AND the
lockfile, regenerate the spec registry and codebase index, keep
platform-specific npm optionals intact, and place the provenance cert.
`scripts/stamp.mjs` encodes the recipe; `template.toml` exposes it.

## 2. Territory

- `scripts/stamp.mjs` (this spec).
- Amends `template.toml` (spec 009; edit both specs together): add
  `scaffold = "node scripts/stamp.mjs"` under `[verbs]`, bump
  `[contract].version` to `0.3.0`.

## 3. Behavior

`node scripts/stamp.mjs --app-name <name> --org <org> [--frontend vue]
[--cert <path-to-born-with.json>] [--stamped-from <template-commit-sha>]`
run from the repo root of a fresh clone:

1. **Validate slots** against `template.toml [slots]` (name pattern
   `^[a-z][a-z0-9-]*$`, org required, frontend in the allowed list).
2. **Substitute app_name**: `package.json` root `"name"` and both
   `"name"` occurrences in `package-lock.json` (root field and the
   `packages[""]` entry). Substrate names (`@enrahitu/*`, the addon
   crate, env prefixes) are deliberately NOT touched: they are the
   chassis, not the app.
3. **Lockfile discipline**: if dependency edits ever become part of
   stamping, refresh with `npm install --package-lock-only` from the
   committed lock; never a full `npm install` on macOS, which prunes
   linux esbuild/rollup platform optionals and breaks `npm ci` on CI
   runners.
4. **Provenance**: when `--cert` is given, copy it to
   `.stagecraft/born-with.json` and run
   `node scripts/verify-born-with.mjs` (spec 012); a failing cert fails
   the stamp.
5. **Regenerate derived truth**: `spec-spine compile && spec-spine index`
   (the app name is a hashed input; stale shards would fail the stamped
   repo's own spine gate). If the `spec-spine` binary is absent, fail
   with the install one-liner; do not skip.
6. **Detach lineage marker**: append a `## Stamped` section to README.md
   naming app, org, template commit, and date.
7. Print a summary and exit 0; any step failure exits non-zero with the
   failing step named. The script is idempotent: re-running with the
   same slots is a no-op that exits 0.

## 4. Acceptance

- A vitest suite for the script (child-process it against a temp copy of
  a minimal fixture tree) covers: happy path, invalid app name, lockfile
  name sync, idempotent re-run, failing cert.
- End-to-end: stamping a fresh clone with a test name leaves
  `npm ci && npm run typecheck && npm test` (the verify verb) green and
  `spec-spine index check` fresh, matching the manual smoke's result.
- Contract version reads 0.3.0; spine gates green.

## 5. Out of scope

- Creating GitHub repos, pushing, or org-side setup (factory, stagecraft
  spec 005).
- Frontend flavor swapping beyond validating the slot value (spec 015
  makes a second value real).
- Cert *content* generation (factory-side; the script only places and
  validates).
