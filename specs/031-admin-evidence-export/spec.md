---
id: "031-admin-evidence-export"
title: "Admin evidence export: the kernel plane as a compliance artifact"
status: approved
created: "2026-07-25"
implementation: pending
depends_on:
  - "020-app-model-contract"
  - "021-kernel-native-consumption"
  - "023-frontend-admin"
  - "024-decision-chain-integrity"
establishes:
  - { kind: directory, path: "backend/evidence/" }
summary: >
  The substrate already holds the two things a security reviewer asks
  for and cannot usually get: a machine-readable statement of every
  capability the application can exercise, and an append-only,
  hash-chained, optionally-signed record of every capability denial. The
  admin dashboard currently presents these as operator telemetry, which
  undersells them by a wide margin. This spec turns the kernel plane
  into an artifact a buyer's auditor is shown: capability diffs between
  two models, so an upgrade's governance change is legible before it is
  deployed; operator-runnable chain verification that produces a
  attestation rather than a log line; and an exportable evidence bundle
  binding model, chain, and verification result together. This is the
  substrate's differentiator and the only item in this batch that is
  about advantage rather than repair.
---

# 031: Admin evidence export

## 1. Purpose

Every other spec authored in this batch fixes something. This one
spends what the fixes protect.

The governance plane the corpus built is genuinely unusual. `app-model.json`
states, machine-readably and verified at boot, every capability each
service may exercise, down to constraints like the rate limiter's
`keyPrefix`. `kernel_decisions` records every denial in a hash chain
that spec 024 made compare-and-swap ordered, boot-verified, fatal on
fork, marked on loss, and signable. No competing self-hosted application
template can hand a security team either artifact, let alone both.

What the substrate does with them today is render them in an operator
dashboard: `/api/admin/overview`, `/api/admin/catalog`, and the trace
endpoints (spec 023). That is a monitoring product. The same data,
addressed to a different reader, is a compliance product, and the second
reader is the one who signs the purchase.

The specific questions that reader asks, which the substrate can answer
and currently does not:

- "What can this application do?" The catalog answers this for one
  version. It does not answer "what changed" between versions, which is
  the question that actually gates an upgrade.
- "Prove it did not do anything else." The chain answers this and there
  is no way to run the proof on demand and take the result away.
- "Give me something I can put in the audit file." Nothing exports.

## 2. Territory

This spec owns `backend/evidence/`: diff computation, verification
orchestration, and bundle assembly. Evidence generation is its own
concern rather than dashboard code, because its reader and its lifetime
differ from the operator surface: a bundle outlives the dashboard
session that produced it, and the diff is useful to a deployment
pipeline that never renders a page.

It amends, without owning:

- `backend/admin/` and `frontend-admin/` (spec 023): the endpoints that
  expose this library and the three views in section 3.4, under the
  existing kill switch and role gate.
- `backend/kernel/` (spec 021): the verification entry point section 3.2
  needs.

## 3. Behavior

### 3.1 Capability diff

Given two app models, produce the governance delta: capabilities added,
removed, and re-scoped; services gaining or losing grants; constraint
changes; trust and gate configuration changes.

The output is written for a reader who is deciding whether to approve a
deployment, so it leads with what expands authority. A diff that reads

> `telemetry` gains `http.egress` on `vendor.example.com`

is the single most valuable sentence this substrate can produce for a
buyer, because it is the sentence that is invisible in every other
deployment model. Reductions in authority are reported too, and clearly
marked as reductions, so the diff is a complete statement rather than an
alarm feed.

The comparison runs against the running cell's booted model on one side
and, on the other, either an uploaded model or the model recorded in an
evidence bundle. Comparing a candidate image's model against production
before deploying it is the primary use.

Model hashes identify both sides, so a diff names exactly which artifacts
were compared and can be re-derived by anyone holding them.

### 3.2 Verification on demand

Spec 024 verifies the Decision chain at boot and makes failure fatal.
That is the right runtime behavior and the wrong auditor experience: the
proof runs where nobody is watching and leaves a process exit as its
only evidence.

An operator-triggered verification runs the same kernel verifier over
the current chain and returns a structured result: records verified,
chain head, genesis, signature coverage when a signing key is active,
and any marked loss windows (spec 024 section 3.3) with their boundaries.
Marked losses are reported prominently rather than folded into a
summary, because "denials were lost here and we know it" is exactly the
kind of honesty that makes the rest of the artifact credible.

Verification is read-only and safe to run against a live cell. It is
gated on the operator role like every other admin surface.

### 3.3 The evidence bundle

One export binding the pieces so they cannot drift apart:

- the app model with its hash and the boot receipt (model hash, gate
  config hash, contract version),
- the Decision chain over a requested window, with genesis and head,
- the verification result from 3.2, timestamped,
- the born-with certificate (spec 012) when the app carries one,
- the image digest and signature reference (spec 029) when available,
- a manifest with a checksum per member.

The bundle is offline-verifiable: it carries what a third party needs to
recheck the chain without access to the running cell. An auditor who is
handed one can confirm it rather than trust it, which is the entire
point.

Bundles are generated on operator request, streamed rather than
buffered (the chain can be large), and rate-limited, since generation is
expensive by nature.

**The bundle contains governance metadata, never application data.**
Decision records carry service, capability, reason, and check ids.
Spec 021's `payloadSummary` and `payloadBody` are excluded from export
by default, because they can carry request-derived content and an
evidence bundle that leaks user data is a liability rather than an
asset. Including them is an explicit, separately-confirmed operator
choice, and the manifest records which mode produced the bundle.

### 3.4 In the dashboard

Three additions to `frontend-admin/`, in the spec 023 idiom: a
governance view showing the current capability surface and diffing it
against an uploaded model; a verification panel that runs 3.2 and shows
the result including any marked losses; and an export control for 3.3.

The dashboard remains flag-gated and operator-gated (spec 023), and the
`admin` slot still prunes all of it at stamp time.

## 4. Acceptance

1. Two models differing by an added capability, a removed capability, a
   re-scoped constraint, and a changed gate config produce a diff naming
   all four correctly, with authority expansions listed first.
2. A diff between identical models reports no change and names the
   shared hash.
3. Verification against a healthy chain returns a result whose record
   count and head match the store; against a chain with a marked loss
   window it reports the window boundaries; against a tampered record it
   reports failure without crashing the running cell.
4. An evidence bundle verifies offline: a script with no access to the
   cell rechecks every checksum, re-derives the chain, and confirms the
   reported head.
5. A bundle produced in default mode contains no `payloadBody` or
   `payloadSummary` field; one produced in the explicit mode contains
   them and its manifest records the mode.
6. Every new endpoint is refused without the operator role and returns
   404 when `ADMIN_UI_ENABLED=false`, matching `backend/admin/gate.ts`.
7. Bundle generation over a large chain streams and does not exhaust
   memory, verified against a seeded chain at least an order of
   magnitude larger than a test fixture.
8. `npm run typecheck && npm test` green, coupling gate green.

## 5. Out of scope

- Mapping capabilities onto named compliance frameworks (SOC 2, ISO
  27001, specific control ids). The substrate produces evidence; framing
  it against a framework is consulting work with a per-customer answer,
  and encoding one framework's vocabulary into the model would be a
  claim this template cannot stand behind.
- Third-party signing or notarization of bundles. Spec 029's image
  signing is the trust root; bundle notarization is a named extension.
- Long-term retention, archival, and pruning policy for the Decision
  chain. Real, and separable: it is a storage-lifecycle question, and
  pruning a hash chain has its own design.
- Alerting or policy enforcement on diffs (blocking a deploy whose diff
  expands authority). That belongs to the fleet's deployment pipeline,
  not to the cell's dashboard.
- Diffing anything other than the governance surface. API and schema
  diffs are a different product built on the same model.
