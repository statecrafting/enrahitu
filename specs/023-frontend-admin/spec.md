---
id: "023-frontend-admin"
title: "frontend-admin: the flag-gated admin dashboard"
status: approved
created: "2026-07-21"
implementation: pending
depends_on:
  - "001-enrahitu-architecture"
  - "004-auth-core"
  - "005-rauthy-same-origin"
  - "009-template-contract"
  - "015-react-rr7-flavor"
  - "019-two-directory-layout"
  - "022-observability-contract"
establishes:
  - { kind: directory, path: "frontend-admin/" }
  - { kind: directory, path: "backend/admin/" }
summary: >
  The first-class admin dashboard spec 001 section 4.4 promises: an
  encore.dev-style operator surface, recreated from the dashapp
  reference (~/DevWork/dashapp), served same-origin by the app itself,
  gated server-side on the <app>_operator role, and flag-gated so the
  end-user of a stamped app chooses whether it exists at all. dashapp
  talked WebSocket JSON-RPC to the Encore daemon; the substrate has no
  daemon, so the dashboard's data plane is a new backend/admin service
  reading the app's own truth: app-model.json and the runtime route
  registry for the catalog and API explorer, the spec 022 trace buffer
  for traces. The lift is a recreation, not a copy: dashapp's own code
  is relicensed into the template by its author, while every
  Encore-owned asset (fonts, logos, wordmarks, Go snippets, generated
  protobuf types, brand design tokens) is excluded and replaced.
  statecraft adopts the result as its platform operator dashboard
  (statecraft spec 012); every stamped app inherits it at stamp time.
---

# 023: frontend-admin

## 1. Purpose

Spec 001 §4.4 defines the surface: `frontend-admin`, first-class,
flag-gated, access gated on the `<app>_operator` role convention
(`enrahitu_operator` here, `statecraft_operator` on the platform,
`<app>_operator` in every stamped cell). The functional reference is
`~/DevWork/dashapp` (spec 001 names it): a working React 19 + React
Router 7 + Vite 7 + Tailwind 4 parity rebuild of Encore's local dev
dashboard, which conveniently matches the spec 015 flavor stack
exactly. This spec turns the reference into the substrate's own
dashboard.

Two facts force a recreation rather than a lift-and-rename:

- **The data plane does not exist here.** dashapp opens a WebSocket
  JSON-RPC connection to the Encore daemon (`/__encore`), whose
  `status`/`traces/list`/`api-call` methods are the daemon's, and some
  of whose surfaces (DB explorer) were built against inferred methods
  that do not exist even there. Spec 008 removed the daemon from this
  substrate on purpose. The dashboard must be re-pointed at the app's
  own truth: the extracted model, the runtime registry, the spec 022
  trace buffer.
- **The provenance is mixed.** dashapp carries no license file and
  embeds Encore-owned material: brand fonts explicitly excluded from
  Encore's license, logos and wordmarks, Encore-Go snippet content,
  and protobuf-generated types from Encore's schemas. The author's own
  reimplementation code can enter Apache-2.0 by their grant; the
  Encore-owned assets cannot and are replaced wholesale.

## 2. Territory

- `frontend-admin/` (new top-level directory): the dashboard app,
  React + React Router v7 + Vite + Tailwind, on the spec 015 flavor
  conventions, building into `backend/web/dist-admin/`.
- `backend/admin/` (new service directory): the same-origin admin API
  and the gated static serving of the dashboard bundle.
- Coordinated edits, each paired with a dated pointer amendment in
  the owning spec: `template.toml` (spec 009: the flag slot and a
  contract version bump), spec 019 (the two-directory layout claim
  gains its deliberate third sibling, flag-gated and prunable), the
  scaffold verb (spec 014's `scripts/stamp.mjs`: keep-or-prune for
  the admin slot), packaging (spec 007/016: bundle when enabled),
  and the model/extractor line (specs 020/021) so the model records
  the admin surface truthfully.

## 3. Behavior

### 3.1 The flag (stamp-time and runtime)

- `template.toml` gains an `admin` slot
  (`default = "on"`, `allowed = ["on", "off"]`); the scaffold verb
  keeps or prunes `frontend-admin/` + `backend/admin/` accordingly,
  the same keep-or-prune mechanism the frontend flavor slot uses.
  This is a `[contract]` version bump, coordinated with the factory's
  reader (statecraft spec 005 consumes `template.toml` and nothing
  else).
- At runtime, `ADMIN_UI_ENABLED=false` disables serving even where
  stamped on (the kill switch). Off means 404, indistinguishable from
  absent.

### 3.2 The gate

- Every `/admin` asset request and every `/api/admin/*` call is
  enforced server-side in `backend/admin/` against the chassis auth
  session: the caller must hold the `<app>_operator` role (the app
  name is known at stamp time; `enrahitu_operator` in the template
  itself). No operator role, no bytes: `permissionDenied` for API
  calls, login redirect for the page. `rauthy_admin` confers nothing
  (role separation per spec 001 §4.4).
- The dashboard is same-origin behind the app (spec 005's posture);
  it authenticates with the ordinary session cookie, adding no new
  auth mechanism, no token plumbing, and no second origin.

### 3.3 The data plane

`backend/admin/` exposes, gated as above:

- **Catalog**: services, endpoints, schemas, derived from
  `app-model.json` plus the runtime route registry (richer request/
  response shapes where the runtime knows them). Replaces the
  daemon's `status.meta` APIMeta.
- **Traces**: recent-trace list, single-trace span detail, and a
  live stream (SSE) of new traces, all reading the spec 022 buffer.
  Replaces `traces/list` + the `trace/new` notification.
- **Overview**: the governed-cell surface: identity posture, the
  model hash, capability summary, observability posture, read-only
  (spec 020 already frames frontend-admin as a model renderer).
- **API caller**: executes a request against the app's own endpoint
  on behalf of the operator's session, returning status/body/timing
  (replaces the daemon's `api-call`). Calls are subject to the
  kernel's ordinary adjudication like any other request; the admin
  surface grants no bypass.

### 3.4 The surfaces (v1)

Recreated from dashapp, in priority order: **Overview** (new, the
governed-cell page), **Service catalog + API explorer** (dashapp's
`AppAPI`/`SchemaView`/`RPCCaller` line), **Traces** (dashapp's
`AppTraces`/`SpanList`/`SpanDetail` line). The flow diagram is a
stretch surface (derivable from model edges; include if cheap).
Explicitly not lifted: the DB explorer (built on daemon methods that
do not exist; a CoreLedger browser is a future spec), snippets
(Encore-Go content), the cloud dashboard stub, and the JSON-RPC/
WebSocket transport (plain HTTP + SSE here).

### 3.5 Provenance rules for the lift

- dashapp's own reimplementation code may be adapted under the
  author's grant and lands as Apache-2.0 with the repo license.
- Excluded and replaced: Encore fonts (system/open font stack
  instead), Encore logos/wordmarks/patch art (neutral template
  identity), Encore design tokens (own token set), Go snippet
  content, `*.pb.ts` generated types (typed against the app-model
  schema and the admin API instead). MIT-licensed vendored bits keep
  their attribution headers.
- Nothing in `frontend-admin/` may claim to be, or visually imitate,
  the Encore product.

## 4. Acceptance

1. In the template dev run, an `enrahitu_operator` session loads
   `/admin` and sees the Overview, the catalog listing real services
   and endpoints, and a trace produced by ordinary API traffic; a
   non-operator session gets no dashboard and `permissionDenied` on
   `/api/admin/*`; signed-out gets the login redirect.
2. The API caller executes a real endpoint round-trip from the
   dashboard, and the resulting request appears in Traces.
3. A stamp with `admin = "off"` contains neither `frontend-admin/`
   nor `backend/admin/` and serves 404 on `/admin`; a stamp with
   `admin = "on"` serves the gated dashboard under
   `<app>_operator`; `ADMIN_UI_ENABLED=false` yields 404 at runtime.
4. `template.toml` carries the `admin` slot and the bumped contract
   version; the factory contract test in the consuming repo reads it
   (cross-repo: statecraft spec 005's reader tolerates or adopts the
   bump before the template release is pinned).
5. The extracted model records the admin surface and operator role
   truthfully; hand-editing it still fails the gate.
6. Verify verbs and spec-spine gates green; the packaged image serves
   the dashboard identically to the dev run.

## 5. Out of scope

- statecraft's adoption and platform branding (statecraft spec 012)
  and any statecraft domain UI (tenants console: statecraft spec 011).
- A CoreLedger data browser (future spec; needs its own privileged
  read model, not inferred daemon RPCs).
- Metrics charting/alerting; the dashboard renders traces and
  catalog, `/metrics` remains scrape-oriented (spec 022).
- The React-only frontend convergence of spec 001 §4.3; this spec
  neither requires nor advances retiring the Vue flavor.
