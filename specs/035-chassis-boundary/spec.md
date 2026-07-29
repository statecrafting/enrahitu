---
id: "035-chassis-boundary"
title: "The chassis/tree boundary and upgrade mechanics"
status: approved
created: "2026-07-29"
implementation: complete
depends_on:
  - "001-enrahitu-architecture"
  - "009-template-contract"
  - "012-born-with-provenance"
  - "018-packaged-chassis"
  - "021-kernel-native-consumption"
  - "034-control-plane"
establishes:
  - { kind: directory, path: "app/" }
  - { kind: file, path: "scripts/gen-manifest.mjs" }
  - { kind: file, path: "scripts/chassis-lock.mjs" }
  - { kind: file, path: "chassis.lock" }
summary: >
  Phase 4 of the pivot (spec 001 §5.1). enrahitu ships as a working
  application an organization extends rather than forks, which is a claim
  about upgrades, and a claim about upgrades is worth nothing unless
  something can check it. This draws the line: `app/` is the organization's
  and an upgrade never reaches into it, everything else is chassis and an
  upgrade replaces it wholesale. Three mechanisms make that real: a manifest
  overlay so an extension can hold capabilities without editing a file the
  upgrade will overwrite, a chassis lock so an upgrade can tell an edited
  chassis file from an untouched one, and a preflight that reports what an
  upgrade would discard before it discards it. Lands before the application
  baseline because it decides what the baseline is allowed to contain.
---

# 035: The chassis/tree boundary

## 1. Purpose

Spec 001 §4.1 says the product "ships as a working application that an
organization extends rather than forks". Every word after "extends" is a
promise about upgrades: that a deployment can take a new chassis version
without a merge, and that whatever it added survives.

Nothing enforced that. Before this spec an organization's only way to add a
capability was to edit `app-manifest.json`, which is a chassis file, so the
first upgrade would silently discard the grant and the extension would start
failing adjudication with no obvious cause. The promise and the mechanism
disagreed, and the mechanism was going to win.

This lands before phase 5 for the reason §5.1 gives: it decides what the
application baseline is allowed to contain. A baseline written without a
boundary produces a boundary drawn around whatever the baseline happened to
do.

## 2. Territory

`app/`, `scripts/gen-manifest.mjs`, `scripts/chassis-lock.mjs`, and
`chassis.lock`. It also renames `app-manifest.json` to
`app-manifest.chassis.json` and makes the former a derived file (§3.3).

## 3. Behavior

### 3.1 The boundary

**`app/` is the organization's. Everything else is the chassis's.**

One directory, not a scattering of extension points. The alternative,
designated extension files inside each chassis directory, fails the only test
that matters: a reader cannot tell by looking at a path whether an upgrade
will overwrite it. One root answers that question from the path alone.

The chassis roster is stated as an **inclusion** list in
`scripts/chassis-lock.mjs`, not as "everything except `app/`". The difference
is not stylistic. An exclusion list makes a newly added top-level directory
chassis-owned by default, so whoever adds one silently takes it away from the
organization. An inclusion list makes the same mistake a missing entry that
`--check` reports on the next commit.

**The roster comes from `git ls-files`, not from a filesystem walk.** The
chassis is what the chassis ships, and git already knows exactly that. A walk
knows only what happens to be on the disk of whoever ran it, so a stale
Playwright report or a local scratch file lands in the lock and CI on a clean
checkout then reports it as a deleted chassis file.

That is not hypothetical. The first version walked the tree with a `SKIP_DIRS`
set, and the gate's own first CI run failed on
`D e2e/artifacts/report/index.html`, a gitignored artifact from a local test
run. The rule the skip list was reaching for (build output and generated trees
are reproducible from what is locked) is what `.gitignore` already says, in one
place, maintained by everyone. A second copy of that list was wrong the moment
the two disagreed, and it disagreed immediately.

### 3.2 The lock and the preflight

`chassis.lock` is a sha256 per chassis file, committed. It ships inside the
artifact.

**Why a lock rather than a diff against upstream.** A diff needs the upstream
tree: a remote, a fetch, and shared history. A stamped app may have none of
those, because spec 012's provenance records where it came from rather than
maintaining a live link back. A hash list travels with the artifact and answers
the question offline, which is the same reason `package-lock.json` exists
rather than resolving the registry on every install.

`npm run upgrade:preflight` sorts every locked file into one of three
outcomes:

| outcome | meaning |
|---|---|
| unmodified | the upgrade replaces it silently; nothing is lost |
| modified | the upgrade would discard a local edit; reported |
| removed | a chassis file was deleted locally; same treatment |

It exits nonzero when anything is modified or removed, and it names each file
with the three honest options: move the change into `app/`, propose it
upstream so every deployment gets it, or accept losing it and re-apply.

Files added inside a chassis root are reported but are not a hazard: they are
the organization's until the chassis ships a file at the same path, and that
collision surfaces as a `modified` on the next lock.

Nothing under `app/` is examined. That is the other half of the contract, and
the preflight says so in its output rather than leaving it to be inferred from
silence.

`npm run check:chassis` is the chassis repo's own gate: here, every change to a
chassis file is legitimate and the lock simply has to keep up, so CI fails when
it has not.

### 3.3 The manifest overlay

`app-manifest.json` is the ceiling the kernel enforces (spec 021), and it has
to carry two authorships at once. So there are two authored files and one
derived:

| file | owner | on upgrade |
|---|---|---|
| `app-manifest.chassis.json` | chassis | replaced wholesale |
| `app/manifest.json` | organization | never touched |
| `app-manifest.json` | derived | regenerated |

`scripts/gen-manifest.mjs` composes them, with `--check` as the CI gate. This
follows `gen-infra-config.mjs` exactly (spec 033 §3.4), including the reason:
a hand-edit to the derived file is caught at the PR rather than discovered as a
capability that exists in the model and in nobody's authored intent.

**The composition refuses rather than merges.** An overlay may add
capabilities, services and resources. It may not redefine a chassis one, and
the collision is an error rather than last-writer-wins. Precedence is the wrong
tool: a silently overridden capability is a widened ceiling that reads, in the
composed file, exactly like a chassis decision. An organization that needs
different chassis grants is asking for a chassis change, and that conversation
should happen out loud.

**One exception**, because without it the boundary would be useless: an overlay
may add capabilities to a chassis service. That is additive, visible in the
composed output, and it is the only way to let an organization's kind be
reconciled by a chassis controller.

Everything else at the top level is the chassis's and is refused by name rather
than ignored: trust levels, the gate roster, ledger settings, observability and
auth are what the chassis *is*. Refusing loudly means a member added to the
chassis later is a legible error for an overlay that tries to set it, not a
quiet no-op.

### 3.4 What an extension is, now that the control plane exists

Phase 3 is what makes the boundary cheap to hold. An extension is:

- **a kind**, registered at runtime (spec 034 §3.2). No migration, no schema
  change, no chassis file touched. This is the single largest reason the
  boundary can be one directory.
- **a controller**, started against those kinds, leased and fenced like any
  other (spec 034 §3.5).
- **a service** with its own endpoints and its own grants, declared in the
  overlay.
- **frontend routes**, which remain the one genuinely unsolved case (§5).

None of those require editing a chassis file, which is the property that had to
be true before phase 5 could ship a domain without freezing it.

## 4. Acceptance

1. The composer adds an overlay capability and sorts deterministically.
2. It refuses to redefine a chassis capability, a chassis resource, or any
   non-capability field of a chassis service, and names what an overlay may set.
3. It lets an overlay add grants to a chassis service, additively and
   deduplicated, leaving the rest of that service untouched.
4. It refuses a chassis-owned top-level member.
5. The derived file carries a generated-by banner.
6. The preflight reports an unmodified tree as safe.
7. It names edited and locally deleted chassis files, and exits nonzero.
8. It reports a file added in a chassis root without calling it a hazard.

All eight are asserted in `scripts/chassis-boundary.test.ts`, and the
end-to-end behavior was verified by editing a chassis file, observing the
report and the nonzero exit, and reverting.

## 5. Out of scope

- **Applying an upgrade.** This spec makes the consequences visible before the
  fact; performing the replacement is the factory's (spec 009) and an
  operational verb's (spec 027). A preflight that reports honestly is the
  prerequisite for an apply that can be trusted, and it is useful alone.
- **Frontend extension.** A route added by an organization still means editing
  a chassis file under `frontend/`. The router would need a registration seam
  equivalent to the kind registry, and designing one on the way past would be
  designing it badly. It is named here rather than left to be discovered:
  **frontend extension is the boundary's one unsolved case.**
- **Moving the composition into the extractor.** Fork 4 of the pivot brief
  decided the seam is the model, so this merge belongs in
  `@statecrafting/toolchain` beside the rest of extraction. It is in-repo first
  deliberately: the composition rules above are new, and a rule set that is
  wrong is much cheaper to change here than in a published package that three
  repositories consume.
- **Per-kind capability grants**, still carried on spec 020 §3.4's named
  extension list (spec 034 §3.3).
