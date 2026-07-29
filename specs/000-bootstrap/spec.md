---
id: "000-bootstrap"
title: "Bootstrap spec system"
status: approved
created: "2026-07-14"
summary: >
  Foundational contract: authored truth lives only in markdown (+ YAML
  frontmatter); machine-consumable truth is compiler-emitted JSON only;
  every artifact is a deterministic function of (config, file contents);
  a typed authority graph governs who-owns-what.
origin:
  retroactive: true   # authority held since before the graph existed
establishes:
  - "spec-spine.toml"
unamendable:
  - "markdown-truth-boundary"
  - "json-truth-boundary"
  - "determinism-requirement"
  - "typed-authority-graph"
  - "refusal-rule"
---

# 000: Bootstrap spec system

This is the spec that defines what a spec *is*. Customize it for your
repository, then author ordinary specs under your specs directory. Each
compilation unit links back here (or to a more specific spec) via
`[package.metadata.spec-spine].spec` in its manifest, a `// Spec:` comment
header, or a spec's ownership edge.

## 1. The authoring / derived boundary

Humans author markdown; the compiler owns the JSON. Never hand-edit a
derived artifact.

## 2. The typed authority graph

Specs declare typed edges (`establishes`, `extends`, `refines`,
`supersedes`, `amends`, `co_authority`, `constrains`, `references`) and
the units they own (file / section / symbol / directory / crate / module).
Authority is derived by walking the graph.

## 3. Repository configuration (`spec-spine.toml`)

`spec-spine.toml`, owned here, declares this repository's layout to the
compiler: the specs / derived / standards directories, the coupling waiver
keyword, the extra hashed governance inputs, and the standalone npm/Rust
packages that carry their own manifests outside the single root package. The
`standalone_npm_packages` list tracks the directory layout; spec 019's
two-directory move renamed the SPA standalone package from `webapp/` to
`frontend/`, updated here with it; spec 015 added the second frontend flavor
`frontend-react/` (the chassis carries every flavor, the scaffold verb prunes
to one at stamp time), updated here with it.

## Amendment (2026-07-29): one standalone npm package

`spec-spine.toml` (this spec's territory) drops `frontend-react` from
`[layout].standalone_npm_packages`, leaving `frontend`. The frontend
flavor slot retired with the React-only convergence (spec 015, contract
v0.7), so there is one SPA manifest outside the root package rather than
two.

The declaration itself still matters and is not vestigial: the repo has no
npm workspaces (spec 001 §4.2 decision 1), so a package that carries its
own `package.json` is invisible to the index unless it is named here.
`frontend-admin/` is deliberately still absent from the list, unchanged by
this amendment; it is governed through spec 023's own edges.
