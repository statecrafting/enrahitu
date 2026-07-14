---
id: "009-template-contract"
title: "The versioned template contract (template.toml)"
status: approved
created: "2026-07-14"
implementation: in-progress
depends_on:
  - "001-enrahitu-architecture"
  - "008-vendored-encore-toolchain"
establishes:
  - "template.toml"
summary: >
  The explicit, versioned interface between this template and the Stagecraft
  factory. The factory learns how to stamp, verify, and package an app from
  this chassis by reading template.toml and nothing else. This replaces the
  implicit coupling that plagued the factory-encore / template-encore pair,
  where the shared assumption (the encore CLI, plus folklore about repo
  layout) lived in two codebases at once and drift surfaced only at stamp
  time. v0 ships the contract file with verify and package verbs live;
  scaffold arrives with the repoInit absorption (spec 010) and deploy is
  permanently fleet-owned.
---

# 009: The versioned template contract

## 1. Purpose

Two lessons from the OAP era motivate this spec (provenance:
knowledge://open-agentic-platform/specs/197-199 and the template-encore
operating history):

1. **Implicit template/factory coupling fails silently.** factory-encore and
   template-encore shared assumptions (the `encore` CLI, directory layout,
   CI expectations) that were written down nowhere. Every template change
   was a potential factory break discovered at stamp time, and vice versa.
2. **Interfaces beat synchronized releases.** The fix is not "release the
   factory and template together"; it is a versioned contract one side
   publishes and the other side pins.

`template.toml` is that contract. The factory (stagecraft's `factory/`
service) reads only this file; the template promises only what this file
says. Everything else in the repo is implementation detail the factory
must not depend on.

## 2. Territory

This spec owns `template.toml` at the repo root. The verbs it references
(`npm run typecheck`, `npm test`, `scripts/docker-build.sh`) remain owned
by their existing specs (001, 007); this spec owns the *binding* of those
commands to contract verbs, not the commands themselves.

## 3. Behavior

### 3.1 Contract shape (v0.1)

- `[template]`: name, template version, license. The license field is load
  bearing: stamped apps copy template code, so it must stay permissive
  (Apache-2.0); an AGPL template would encumber every generated app.
- `[contract].version`: semver for the *schema of this file*. The factory
  pins a compatible range (`^0.1`). Adding an optional key is a minor bump;
  changing or removing a key, or changing a verb's meaning, is a major bump.
- `[requires]`: runtime requirements of a stamped app (node >= 24). Rust
  and protoc are template-development requirements only and are
  deliberately absent.
- `[slots]`: the values the factory substitutes at stamp time. v0: app
  name, org, and the `frontend` flavor knob. The knob exists so frontend
  variants are a slot, not a fork: `vue` is the only allowed value today;
  `react-rr7` is the planned second flavor and `svelte` earns a slot on
  demand. Each added flavor is a minor contract bump.
- `[verbs]`: commands the factory runs inside a stamped repo, exit code as
  verdict. v0 live verbs: `verify`, `package`.

### 3.2 Verb semantics

- `verify`: the born-green gate. Must pass in a freshly stamped repo with
  no network access beyond the npm registry.
- `package`: produces the single-container image (spec 007/008 pipeline).
- `scaffold` (reserved): in-template seeding logic; arrives with the
  repoInit absorption (spec 010). Until then, stamping is factory-side
  (clone + slot substitution).
- `deploy` (reserved, permanently): deployment is the Stagecraft fleet
  service's job. A template that deploys itself would re-couple the
  chassis to an operations backend, which is exactly the coupling this
  substrate exists to sever.

### 3.3 Provenance hooks (reserved)

The born-with certificate and agentic-posture binding (OAP specs
203/210/220 lineage, the tenant-emit / tenant-tail ecosystem) will bind
at stamp time. A `[provenance]` table is reserved for the contract minor
version that lands with spec 010; it is intentionally absent from v0
rather than present-but-lying.

## 4. Out of scope

- Deploy semantics (fleet-owned, see 3.2).
- A multi-template registry or template discovery; Stagecraft pins this
  one chassis for now.
- Slot substitution mechanics inside the factory (owned by stagecraft's
  factory spec, which consumes this contract).
