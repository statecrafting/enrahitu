# AGENTS.md: enrahitu

This file is the cross-agent session-init protocol authority, read by Claude
Code, Codex CLI, Cursor, and GitHub Copilot via the AAIF/Linux Foundation
AGENTS.md standard. It is the single source for the init protocol: tooling that
runs `/init` reads the `## New Sessions` section to derive its plan.

Governance is provided by `spec-spine` (installed on your `PATH`). All governed
reads of compiled artifacts go through its CLI. Bootstrap spec:
`specs/000-bootstrap/spec.md`.

## New Sessions

Run `/init` as the first action of every new session. It reads this section to
derive its execution plan dynamically: any item added here is automatically
picked up on the next init.

> AGENTS.md is loaded implicitly as the protocol source; its contents are the
> protocol, so `/init` does not list AGENTS.md as a parallel identity read in
> Step 1 (avoiding the self-reference loop).

**Init protocol:**

0. **Load rules** (read first): `.claude/rules/orchestrator-rules.md`,
   `.claude/rules/governed-artifact-reads.md`, and
   `.claude/rules/adversarial-prompt-refusal.md`.

1. **Refresh the registry, then parallel reads.** Run `spec-spine compile`
   first (the registry is a deterministic artifact; recompiling guarantees
   lifecycle counts reflect the current `specs/*/spec.md` frontmatter), then
   dispatch simultaneously:
   - `CLAUDE.md`: project overview, governance model, conventions
   - `README.md`: full project description
   - `standards/spec/contract.md`: the short normative spec-spine contract
   - `standards/spec/constitution.md`: durable constitutional baseline
   - `spec-spine index check`: staleness gate for the codebase index (non-fatal)
   - `spec-spine registry status-report --json --nonzero-only`: lifecycle counts
   - `spec-spine registry list --ids-only`: spec inventory (for latest-spec detection)
   - `ls backend frontend addon docker packages vendor/encore`: application surface discovery (services + lib + core live under `backend/`; SPA under `frontend/`; spec 019)
   - `ls docs/`: docs surface
   - `git log --oneline -10`: recent history
   - `git diff --stat HEAD~1`: last change summary

2. **Emit** an `## initialized: enrahitu` summary block (layer overview,
   recent activity, ready-to-help line), with a `## lifecycle:` sub-section
   populated from the `status-report` output.

**Read discipline:** the init protocol MUST NOT parse `.derived/**/*.json`
directly (no `python`, `jq`, `awk`, `sed` against compiled artifacts). All
structural and lifecycle data comes from `spec-spine` subcommands.

**Staleness surface:** if `spec-spine index check` exits non-zero, include
"Codebase index: stale, run `spec-spine index`" in the summary and continue.

**CLI missing:** if `spec-spine --version` fails, run `/setup`. Do NOT fall back
to ad-hoc parsing of `.derived/**/*.json`.

If any file is missing: log "not found" and continue.

## Available Agents

Agents live in `.claude/agents/`. Four pipeline agents handle the
plan/explore/implement/review cycle:

- `architect`: plans and decomposes tasks, validates approaches against specs. Read-only.
- `explorer`: searches the codebase, traces dependencies, gathers context. Read-only.
- `implementer`: executes focused changes from an existing plan. Minimal diffs.
- `reviewer`: post-change review for bugs, correctness, performance, spec compliance. Read-only.

## Available Commands

Skills live in `.claude/skills/`:

- `/init`: initialize a session (this protocol).
- `/setup`: one-time contributor setup; installs spec-spine and verifies the governed loop.
- `/commit`: create a git commit with an impact-focused conventional message.
- `/code-review`: review the working diff for correctness bugs and spec drift.
- `/ship`: run the gate, review, commit on a feature branch, open a PR.
- `/validate-and-fix`: run the local CI loop and fix discovered issues.
- `/cleanup`: dead-code and duplicate detection with categorized recommendations.
- `/implement-plan`: execute a plan file step-by-step with progress tracking.
- `/research`: deep research with parallel sub-agents.
- `/refactor-claude-md`: tighten and restructure a `CLAUDE.md`.

## Working the backlog

This repo's backlog is its spec corpus: every spec with
`implementation: pending` is a work order. One session implements one
spec, start to finish. Build order (decided 2026-07-14: statecraft's
app-shell import waits on the slimmed template, so 018/019 jump the
queue): 018 (packaged chassis) then 019 (frontend/backend layout)
FIRST; then 011 (Postgres driver), 012 (born-with provenance), 014
(scaffold verb; needs 012), then 013 (Pages), 016 (amd64; its
cross-build matrix is largely delivered by 018's publish pipeline),
017 (IdP e2e) in any order, and 015 (react-rr7 flavor; needs 014)
last. Specs 011-017 that name pre-019 paths are amended to the new
layout as part of whichever spec moves them (019 §3).

1. Pick the next spec: the lowest-numbered spec whose frontmatter says
   `implementation: pending` and whose `depends_on` specs are all
   implemented (`spec-spine registry show <id>` to inspect). If a
   spec's dependency or prerequisite section names something missing,
   stop and report exactly what is needed instead of mocking around it.
   Note: spec 011 is `status: draft` with pending implementation; treat
   it as claimable, and promote it to approved as part of implementing.
2. Flip the spec to `implementation: in-progress` when you start.
3. Re-read the spec fully before coding. If the design is imprecise or
   wrong, amend the spec FIRST (design truth precedes code), then
   implement. Never edit a spec afterwards to ratify what the code
   happened to do. Contract changes (template.toml) always bump
   `[contract].version` per spec 009 §3.1 and edit spec 009 together
   with the owning spec.
4. Implement within the spec's territory. Before every commit:
   `spec-spine compile && spec-spine index &&
   spec-spine lint --fail-on-warn && spec-spine index check`, plus
   `npm run typecheck && npm test` (the contract verify verb) and any
   build steps the change touches (CLAUDE.md).
5. Satisfy the spec's Acceptance section verbatim. If an item cannot
   be satisfied (external state, missing sibling repo work), keep
   `implementation: in-progress`, add a dated Status note to the spec
   saying exactly what remains, and report it. Flip to
   `implementation: complete` only when acceptance holds.
6. Commit with a conventional message referencing the spec id
   (`feat(012): ...`), include the regenerated `.derived/` shards, and
   push to main. Then stop: the next session takes the next spec.

## Conventions

- Items added to the "New Sessions" init protocol are auto-loaded on the next init.
- Orchestrated workflows read compiled artifacts (`.derived/**`) through
  `spec-spine` subcommands, never via ad-hoc parsers (see
  `.claude/rules/governed-artifact-reads.md`).
- Every substantive change is bound to a spec; owned paths and their owning
  `spec.md` move together (`spec-spine couple` enforces this at PR time).
