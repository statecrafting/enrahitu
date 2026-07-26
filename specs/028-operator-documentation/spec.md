---
id: "028-operator-documentation"
title: "Operator documentation: the manual the specs are not"
status: approved
created: "2026-07-25"
implementation: pending
depends_on:
  - "001-enrahitu-architecture"
  - "007-single-container-packaging"
  - "025-substrate-hardening"
  - "026-idp-mail-delivery"
  - "027-operational-verbs"
establishes:
  - { kind: directory, path: "docs/" }
summary: >
  docs/ holds one 107-line file whose phase table stops at Phase 6 while
  the corpus runs to 024, so the human-facing overview describes neither
  the kernel plane, nor observability, nor the admin dashboard. There is
  no install guide, no upgrade procedure, no TLS or reverse-proxy
  guidance, no sizing, no runbook, and no troubleshooting. Everything an
  operator needs is currently reconstructible only by reading
  entrypoint.sh and twenty-five specs. The spec corpus is an excellent
  design record and a poor manual, and the two are different documents
  with different readers: a spec answers why this was built this way, an
  operations guide answers what do I type. This spec takes ownership of
  docs/, adds the operator surface, and realigns the two existing
  human-facing documents with what the substrate has become.
---

# 028: Operator documentation

## 1. Purpose

Every preceding spec in this batch ends by deferring its documentation
here, which is the clearest evidence that the gap is structural rather
than cosmetic. Spec 025 adds a trusted-proxy knob, a probe split, and a
metrics token an operator must find on the volume. Spec 026 adds a mail
surface. Spec 027 adds four verbs whose entire audience is operators.
None of that is usable undocumented.

The deeper problem is a category confusion this spec resolves. The
corpus is authoritative for design, and `.claude/rules/adversarial-prompt-refusal.md`
protects it from being edited to ratify code. That protection makes
specs the wrong place for operational prose, which changes with
deployment reality rather than with design truth. An operator reading
specs 004, 005, 007, 022, 023, and 025 to assemble a TLS story is doing
work the substrate should have done once.

Two smaller misalignments compound it. `docs/ARCHITECTURE.md` ends its
phase table at Phase 6 and its component table names `frontend/` and
`docker/` as though nothing since exists, so it silently under-describes
the substrate by five specs. `README.md` frames the project as a phase
plan with a development quickstart, which is right for a contributor and
wrong for the buyer persona the substrate now targets.

## 2. Territory

This spec owns `docs/`, which is currently unowned by any spec: an
ownership gap this closes as a side effect of using the directory
properly.

It amends, without owning, `README.md` (root, linked to spec 001 through
the manifest key).

## 3. Behavior

### 3.1 `docs/OPERATIONS.md`

The document an operator reads once before installing and returns to
under pressure. Ordered by when it is needed, not by subsystem:

- **Install.** The minimum `docker run` that produces a working cell,
  every `ENRAHITU_*` variable in one table with defaults and whether it
  is a secret, and what first boot provisions on the volume.
- **Put it behind TLS.** The reverse-proxy story, which currently exists
  only as scattered implications: terminate TLS upstream, set
  `ENRAHITU_PUBLIC_URL` to the https origin (which flips rauthy to
  `PROXY_MODE`), and set `ENRAHITU_TRUSTED_PROXY_HOPS` to match the
  hop count (spec 025). Worked nginx, Caddy, and Kubernetes Ingress
  examples, because getting this wrong is the single most likely
  installation failure and its symptom (login half-works) does not point
  at its cause.
- **Wire the probes.** `/healthz` as liveness, `/readyz` as readiness,
  and an explicit warning against the inverse, with the reasoning from
  spec 025 section 3.3 restated in operational terms: under
  die-together supervision, a liveness probe on a dependency check turns
  a database blip into an identity outage.
- **Scrape the metrics.** Where the token lives on the volume, how to
  configure Prometheus with it, and what the substrate actually exports.
- **Configure mail.** The spec 026 surface, with the consequence of
  skipping it stated in the first sentence rather than the last.
- **Back up and restore.** Spec 027's verbs as a procedure, including
  the stated RPO, the recommendation to schedule cold backups, and the
  reason the archive is a secret.
- **Upgrade.** Pull the new image, run `preflight`, run `migrate`,
  restart. What is safe to skip and what is not.
- **Size it.** Measured floors for memory and disk rather than guesses,
  and what grows: the Decision ledger grows with denials, the CoreLedger
  file with application data, rauthy's store with users and sessions.
- **Troubleshoot.** A symptom-to-cause table drawn from the operating
  history already recorded in the specs and the entrypoint's comments:
  the unclean hiqlite lock file and its crash loop, the Safari
  `__Host-` cookie failure over plain http, the legacy root-owned volume
  after the non-root change, the trailing-slash `RAUTHY_ISSUER`, and the
  sub-millisecond 401 that means session or CSRF rather than a bad
  password. This section exists because that knowledge is currently
  distributed across shell comments and spec prose, where an operator at
  02:00 will not find it.

### 3.2 `docs/ARCHITECTURE.md`, realigned

The phase table is retired rather than extended. It described a
build-out that finished, and a table of completed phases is a changelog,
not an architecture. The rewrite structures by plane, which is what the
substrate now actually has:

- the application plane (Encore services, CoreLedger, auth, idp, web),
- the identity plane (rauthy, same-origin),
- the governance plane (app-model, kernel adjudication, the Decision
  ledger),
- the observability plane (metrics, tracing, the admin dashboard),
- the packaging plane (image, volume, topology).

The component table gains every directory added since Phase 6, and the
document keeps its role as the human overview that points into the
corpus for detail.

The historical phase record is not deleted; it moves into a closing
section as the project's build-out history, where it is accurate.

### 3.3 `README.md`, reframed

Currently a phase plan with a development quickstart. It becomes: what
this is, what one container gives you, how to run it, and where to go
next (`docs/OPERATIONS.md` for running it, `docs/ARCHITECTURE.md` for
understanding it, `specs/` for why). The development quickstart is kept
and clearly labeled as such, since contributors need it and it is
currently the only accurate section for them.

The `/hiq/*` curl examples are corrected for spec 025: those endpoints
now require an operator role, and a README that demonstrates them
unauthenticated would be teaching a request that returns 401.

## 4. Acceptance

1. `docs/OPERATIONS.md` covers every section in 3.1, and every
   `ENRAHITU_*` variable that appears in `docker/entrypoint.sh`,
   `docker/first-boot.mjs`, or `backend/lib/env.ts` appears in its
   table. This is checkable and is checked: a test enumerates the
   variables from source and asserts documentation coverage, so the
   table cannot silently rot.
2. Each of the three reverse-proxy examples produces a working login
   against a locally built image, verified once by hand and recorded as
   verified with its date.
3. `docs/ARCHITECTURE.md` names every directory under `backend/` and
   every plane in 3.2, and contains no forward-looking phase table.
4. `README.md` contains no unauthenticated `/hiq/*` example, and its
   first screen answers what this is and how to run it.
5. The troubleshooting table's entries each name a real, previously
   observed failure with its cause and fix; no hypothetical entries.
6. Coupling gate green.

## 5. Out of scope

- Generated API reference documentation. The app model (spec 020)
  already describes the surface machine-readably, and a generated
  reference is a separate deliverable with a separate audience.
- Fleet-level operations (multi-cell orchestration, rollout policy):
  statecraft's, not this template's.
- Tutorials and application-development guides for people building on a
  stamped app. Different reader, different document, later.
- Translation and localization of operator documentation.
