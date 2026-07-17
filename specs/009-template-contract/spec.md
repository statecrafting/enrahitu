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
  The explicit, versioned interface between this template and the Statecraft
  factory. The factory learns how to stamp, verify, and package an app from
  this chassis by reading template.toml and nothing else. This replaces the
  implicit coupling that plagued the factory-encore / template-encore pair,
  where the shared assumption (the encore CLI, plus folklore about repo
  layout) lived in two codebases at once and drift surfaced only at stamp
  time. v0 shipped the contract file with verify and package verbs live;
  scaffold landed with the repoInit absorption (spec 014, contract 0.4.0)
  and deploy is permanently fleet-owned.
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

`template.toml` is that contract. The factory (statecraft's `factory/`
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
  Worked minors: v0.2 added `[requires].toolchain` (spec 018); v0.3 added
  the `[provenance]` table (spec 012); v0.4 made the reserved `scaffold`
  verb live (spec 014); v0.5 added the `react-rr7` frontend flavor to the
  `frontend` slot's allowed list (spec 015).
- `[requires]`: runtime requirements of a stamped app. `node >= 24`, and
  (contract v0.2, spec 018) `toolchain = "^0.1"`: the `@enrahitu/toolchain`
  chassis package a stamped app devDepends on for its build drivers and
  prebuilt native binaries. Adding this optional key was a minor contract
  bump (0.1 to 0.2), the worked example of the rule below. Rust and protoc
  remain template-development requirements only and are deliberately absent.
- `[slots]`: the values the factory substitutes at stamp time. v0: app
  name, org, and the `frontend` flavor knob. The knob exists so frontend
  variants are a slot, not a fork: `vue` and `react-rr7` are the allowed
  values (the second landed with spec 015, contract v0.5); `svelte` earns
  a slot on demand. Each allowed value maps to a sibling flavor directory
  the scaffold verb keeps or prunes (spec 014/015). Each added flavor is a
  minor contract bump.
- `[verbs]`: commands the factory runs inside a stamped repo, exit code as
  verdict. Live verbs: `verify`, `package`, and (contract v0.4, spec 014)
  `scaffold`.

### 3.2 Verb semantics

- `verify`: the born-green gate. Must pass in a freshly stamped repo with
  no network access beyond the npm registry.
- `package`: produces the single-container image (spec 007/008 pipeline).
- `scaffold` (live, contract v0.4): in-template stamping logic. Run from a
  fresh clone, it validates slots, substitutes the app name in the manifest
  and lockfile, places and validates the provenance cert, regenerates the
  derived truth, and writes a README lineage marker. Owned by spec 014
  (`scripts/stamp.mjs`); the recipe it encodes was the folklore that
  factory-side clone + substitution relied on before v0.4.
- `deploy` (reserved, permanently): deployment is the Statecraft fleet
  service's job. A template that deploys itself would re-couple the
  chassis to an operations backend, which is exactly the coupling this
  substrate exists to sever.

### 3.3 Provenance hooks

The born-with certificate and agentic-posture binding (OAP specs
203/210/220 lineage, the tenant-emit / tenant-tail ecosystem) bind at
stamp time. The `[provenance]` table landed at contract 0.3.0 with spec
012 (LI-2 of the spec-010 absorption): it names the cert path, its
schema, the template-owned validator verb, and the closed posture set.
The template carries the schema and validator but never a cert instance;
the instance lives only in stamped repos, written by the factory. It was
intentionally absent from v0 rather than present-but-lying.

## 4. Out of scope

- Deploy semantics (fleet-owned, see 3.2).
- A multi-template registry or template discovery; Statecraft pins this
  one chassis for now.
- Slot substitution mechanics inside the factory (owned by statecraft's
  factory spec, which consumes this contract).
