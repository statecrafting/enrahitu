---
id: "025-substrate-hardening"
title: "Substrate hardening: the exposed surface, forge-proof client identity, probe separation"
status: approved
created: "2026-07-25"
implementation: complete
depends_on:
  - "001-enrahitu-architecture"
  - "002-in-process-hiqlite"
  - "004-auth-core"
  - "005-rauthy-same-origin"
  - "007-single-container-packaging"
  - "021-kernel-native-consumption"
  - "022-observability-contract"
establishes:
  - "backend/lib/client-identity.ts"
  - "backend/lib/client-identity.test.ts"
  - "docker/first-boot.test.ts"
summary: >
  Four defects that only exist once the cell is actually exposed on a
  network, found by an external review of the packaged image and
  verified against the code. The hiq demo endpoints are public and
  unauthenticated while holding an unconstrained counter capability,
  which lets any remote caller forge the rate limiter's own buckets and
  lock a chosen IP out of login. Client identity is taken from an
  unvalidated X-Forwarded-For on both the typed and raw paths, so the
  limiter is evadable and rauthy inherits the spoof through the proxy.
  The liveness endpoint performs a ledger query, so a transient store
  blip restarts a container that the die-together supervisor then takes
  down whole, and the image declares no HEALTHCHECK at all. The metrics
  endpoint is unauthenticated on the public port with its own comment
  citing deployment guidance that was never written. This spec closes
  all four: the demo surface becomes operator-gated and demo-scoped at
  the capability layer, client identity becomes forge-proof by
  construction, liveness separates from readiness, and metrics gains a
  first-boot-provisioned bearer token without weakening spec 022's
  always-on contract.
---

# 025: Substrate hardening

## 1. Purpose

Specs 002 through 024 built the cell. This spec is the first to treat
it as something reachable by a stranger.

Every defect here shares a shape: a decision that was correct when the
surface was a developer's laptop, and wrong the moment
`docker run -p 8080:8080` put it on a network. None of them is a flaw
in the governed-cell thesis. Three of the four are the substrate
failing to use protections it already built, and the fourth is a
missing container primitive.

The first is not merely an exposed surface; it is a privilege
inversion the model itself already documents. `backend/hiq/api.ts`
exposes six endpoints with `expose: true` and no `auth: true`, and
`backend/hiq/encore.service.ts` mounts `obsMiddleware` alone, while the
sibling `auth` service mounts
`[obsMiddleware, securityHeaders, csrfMiddleware, apiRateLimit]`. In
`app-manifest.json` the `hiq` service holds `cap.counter.add` with no
constraints, while `auth` holds the same kind constrained to
`keyPrefix: "rl:"`. The constraint on the auth grant exists precisely
because unconstrained counter access is dangerous. The demo service
was handed the dangerous grant and then published without a gate.

The consequence is concrete. `bucketKey` in
`backend/lib/rate-limit-window.ts` is `rl:${tier}:${clientKey}:${window}`
with `window = floor(Date.now() / 60000)`, and it contains no slash, so
it fits one path segment. Eleven unauthenticated calls to
`POST /hiq/counter/rl:auth:<victim>:<window>/add` exhaust `AUTH_LIMIT`
(10) for a chosen client and deny it login for the rest of the minute;
101 calls against the `api` tier do the same for the whole API. The
same endpoint set also permits unbounded anonymous writes into the
raft-replicated store on the persistent volume.

The second defect compounds the first and stands alone without it.
`clientKey` in `backend/lib/rate-limit.ts` and `clientIp` in
`backend/auth/http.ts` both take the leftmost `X-Forwarded-For` value
with no notion of which hop, if any, is trustworthy. `clientIp` even
prefers that header over the socket address it already holds. In the
packaged image the app is exposed directly on 8080, so a caller sets
its own header and receives a fresh bucket per request: the limiter
counts an attacker-chosen string. `backend/idp/proxy.ts` then appends
the socket address to whatever the client supplied and forwards the
result to rauthy, which trusts it under `TRUSTED_PROXIES=127.0.0.0/8`,
so rauthy's own IP-based defenses inherit the forgery.

The third is a category error with a supervisor multiplier.
`backend/health/api.ts` runs `SELECT 1` against CoreLedger inside
`GET /health`. Pointed at a Kubernetes livenessProbe, a transient
Turso or Postgres blip restarts the pod; under the die-together
entrypoint (`docker/entrypoint.sh`, `wait -n`) that restart also ends
rauthy. A dependency wobble becomes an identity outage. `docker/Dockerfile`
declares no `HEALTHCHECK`, so a plain Docker or Compose operator has no
health signal at all.

The fourth is a documentation debt that reads as a control.
`backend/obs/api.ts` serves `/metrics` unauthenticated and its comment
says "deployment guidance keeps it off the public ingress". No such
guidance exists in this repository, and the app offers no second
listener a network policy could bind. The comment describes a control
nobody implemented.

## 2. Territory

This spec owns `backend/lib/client-identity.ts` and its test (the single
resolver for "who is calling", used by every tier that needs a client
key), and `docker/first-boot.test.ts`, which covers the write-once
property of provisioning now that a scraper credential depends on it.
`docker/` is not directory-owned, so the new test needed an explicit
home; `backend/obs/metrics-auth.ts` and its test do not, since spec 022
owns that directory.

It amends, without taking ownership of, the behavior of:

- `backend/hiq/` (spec 002): endpoint gating, service middleware.
- `backend/lib/rate-limit.ts` and `backend/auth/http.ts` (spec 004):
  both client-key derivations route through the new resolver.
- `backend/idp/proxy.ts` (spec 005): the forwarded header is rebuilt
  from the resolved identity rather than concatenated blindly.
- `backend/health/` (spec 001): the probe split.
- `docker/Dockerfile` and `docker/first-boot.mjs` (spec 007): the
  `HEALTHCHECK` and the provisioned metrics token.
- `app-manifest.json` (spec 021): the hiq grants.
- `backend/obs/api.ts` (spec 022): bearer authentication in front of an
  endpoint that stays always-on.

## 3. Behavior

### 3.1 The hiq surface: operator-gated and demo-scoped

Two independent barriers, because either one alone has a failure mode
the other covers.

**The gate.** The five data endpoints (`kvPut`, `kvGet`, `kvDel`,
`counterAdd`, `counterGet`) take `auth: true` and call the operator
role check that `backend/admin/gate.ts` already established for spec
023: `requireRole(getAuthData()!, operatorRole())`, reading the role
name from the model's `auth.operatorRole`. The hiq service does not
adopt `requireAdminEnabled()`: `ADMIN_UI_ENABLED` is the dashboard's
kill switch and has no authority over this service.

`GET /hiq/health` stays public and unauthenticated. It returns a status
string, leaks nothing, and is the liveness target the image smoke in
`.github/workflows/image.yml` already curls.

`backend/hiq/encore.service.ts` mounts
`[obsMiddleware, securityHeaders, csrfMiddleware]`, observation outermost
per spec 022. This is the admin service's chain (spec 023), not the auth
service's, and the difference is load bearing.

`apiRateLimit` is deliberately **not** mounted, for the same reason
`backend/admin/encore.service.ts` already records ("No rate limiter:
this is an operator-only surface behind the role gate"), plus a second
reason specific to this service that the extraction gate surfaced.
Mounting the limiter makes its own `rl:`-prefixed counter writes execute
with `hiq` as the acting service, since middleware runs under the
mounting service's attribution. A `hiq` service scoped to `demo:` would
have those writes denied by the kernel, `increment()` would catch the
denial and fail open, and the limiter would silently never enforce.
Restoring enforcement would mean granting `hiq` the `rl:`-constrained
counter capabilities, and a service holding both a `demo:` and an `rl:`
grant of the same kind can satisfy either, which reopens exactly the
bucket-forgery path this section exists to close. Operator gating is the
correct control for this surface; a rate limiter on top of it would have
to buy back the ceiling it costs.

**The scope.** Gating alone leaves an over-broad grant one
misconfiguration away from the same exploit. The hiq grants in
`app-manifest.json` are therefore replaced by demo-scoped capabilities:

| was | becomes | constraint |
|---|---|---|
| `cap.counter.add` | `cap.counter.demo.add` | `keyPrefix: "demo:"` |
| `cap.counter.get` | `cap.counter.demo.get` | `keyPrefix: "demo:"` |
| `cap.kv.cache.put` | `cap.kv.demo.put` | `keyPrefix: "demo:"` |
| `cap.kv.cache.get` | `cap.kv.demo.get` | `keyPrefix: "demo:"` |
| `cap.kv.cache.delete` | `cap.kv.demo.delete` | `keyPrefix: "demo:"` |

`kind` and `resource` are unchanged, because `demand()` in
`backend/kernel/adjudicate.ts` matches on those and the capability id is
a label. The unconstrained ids are deleted outright: a grep of the tree
confirms the `hiq` service was their only holder, and the rate limiter
reaches counters through `auth`'s `cap.counter.rate-limit.*` grants,
which are untouched.

After this change an `rl:`-prefixed key is unreachable from the hiq
service by construction. A future regression that drops the auth
annotation re-exposes a demo keyspace, not the rate limiter.

### 3.2 Trusted client identity

`X-Forwarded-For` is evidence, not identity. It becomes identity only
when an operator states how many hops in front of the app are its own.

`backend/lib/client-identity.ts` exports one resolver governed by
`ENRAHITU_TRUSTED_PROXY_HOPS`, a non-negative integer defaulting to `0`.
Hops are counted from the right, because the rightmost entries are the
ones infrastructure appended and the leftmost are the ones a client can
invent:

- **`hops = 0`** (default, and the correct value for the packaged image
  run with `-p 8080:8080`): the header is not believed at all. The
  client is the transport peer.
- **`hops = N > 0`**: the client is the Nth entry from the right of the
  combined `X-Forwarded-For` list. A list shorter than N means the
  declared topology is not the one serving the request; the resolver
  reports no trusted identity rather than guessing.

The resolver returns a discriminated result, not a bare string, so that
callers cannot silently treat "untrusted" as "some client":
`{ trusted: true, client: string }` or `{ trusted: false }`.

**The raw path** (`backend/auth/http.ts`, `backend/idp/proxy.ts`) has
`req.socket.remoteAddress` and therefore always resolves an identity:
the trusted XFF entry when `hops > 0`, the socket address otherwise.
`clientIp` stops preferring the header over the socket. The auth-tier
limiter, which is what actually guards against brute force and lockout,
becomes forge-proof in both modes.

**The typed path** cannot do this. Encore's `APICallMeta` carries
`headers` and no peer address (verified against `encore.dev`), so
`apiRateLimit` middleware has no socket to fall back to. Rather than
pretend, the middleware is explicit about which mode it is in:

- `hops > 0`: keyed on the resolved client, as today but trustworthy.
- `hops = 0`: no per-client identity exists at this tier. The middleware
  keys on the endpoint rather than the caller and enforces a separate,
  deliberately coarse ceiling under the `api:global:<endpoint>` bucket.
  This is honest degradation: a shared ceiling that cannot be evaded,
  instead of a per-client ceiling that can. It is documented as such,
  and `ENRAHITU_TRUSTED_PROXY_HOPS` is the operator's lever to get the
  precise tier back.

Fail-open on backend error (spec 004) is unchanged: availability over
enforcement, still recorded.

**The proxy.** `backend/idp/proxy.ts` stops concatenating the prior
header with the socket address. It sets `X-Forwarded-For` to the
resolved client identity followed by this hop, so the chain rauthy
receives under `TRUSTED_PROXIES=127.0.0.0/8` contains only values this
app vouches for. Untrusted client-supplied entries are dropped, not
forwarded.

### 3.3 Liveness and readiness, separated

Two endpoints with two different questions and two different
consequences for answering "no":

- **`GET /healthz`**: is this process alive and serving? No dependency
  is touched. This is the livenessProbe and the image `HEALTHCHECK`
  target. It fails only when the process cannot answer, and the correct
  response to that is a restart.
- **`GET /readyz`**: should this instance receive traffic? Checks
  CoreLedger (`SELECT 1`) and hiqlite (the addon health call, which the
  governed facade leaves unadjudicated as a lifecycle probe). This is
  the readinessProbe. It fails when a dependency is unavailable, and the
  correct response is to stop routing, not to restart.

  The rauthy upstream is deliberately **not** probed here. Reaching it
  would require granting the `health` service `cap.egress.rauthy-upstream`,
  which today only `idp` holds: a standing authority expansion, paid on
  every readiness poll, to answer a question that is already answered
  elsewhere. In the `cell` topology the entrypoint waits for rauthy
  before starting the app and the die-together supervisor ends the
  container if rauthy exits, so an app-level probe is redundant. When
  the `app` role separates them (spec 030), the idp service becomes a
  distinct deployment with its own probe.

`GET /health` is retained as a permanent alias of `/readyz`, preserving
its current semantics exactly. Nothing that scrapes it today changes
behavior, including the image smoke and the e2e globalSetup.

`docker/Dockerfile` gains a `HEALTHCHECK` against `/healthz` using
`node -e` with `fetch`, matching the entrypoint's existing probe idiom
(`node:24-trixie-slim` ships no curl).

### 3.4 The metrics endpoint

Spec 022 makes `/metrics` non-negotiable and unflagged. This spec adds
authentication without adding a flag, and makes the secure state the
default in the packaged image rather than an opt-in.

`ENRAHITU_METRICS_TOKEN`, when set, requires
`Authorization: Bearer <token>` on `GET /metrics`; a missing or wrong
token is 401. When unset, the endpoint serves unauthenticated, which
keeps `npm run dev` and the existing tests frictionless.

`docker/first-boot.mjs` provisions the token exactly as it provisions
every other secret: generated once, `writeOnce`, mode 0600, at
`$DATA/keys/metrics-token`, and exported by `docker/entrypoint.sh` into
the app process. The packaged image is therefore authenticated by
default, and an operator reads the token out of the volume to configure
a scraper. The endpoint is still always on, still unflagged, and spec
022's contract is intact.

## 4. Acceptance

1. **The exploit is closed twice.** An unauthenticated request to each
   of the five hiq data endpoints is rejected before reaching the
   addon. With authentication forced on in a test, a key outside the
   `demo:` prefix is refused by the kernel with `KERNEL_DENIED`, and a
   `demo:`-prefixed key succeeds. `POST /hiq/counter/rl:auth:x:y/add`
   fails on both barriers independently.
2. **Grants are narrowed, not merely renamed.** `app-model.json`
   regenerated by `npm run extract:model` shows the `hiq` service
   holding five capabilities, each carrying `keyPrefix: "demo:"`, and
   no capability of kind `counter.add` on resource `counters` without
   constraints exists anywhere in the model. `npm run check:model`
   passes.
3. **Identity cannot be forged.** With `ENRAHITU_TRUSTED_PROXY_HOPS`
   unset, a request carrying an arbitrary `X-Forwarded-For` is keyed on
   its socket address on the raw path; the header does not influence the
   bucket. With hops set to 1, the rightmost entry is used, and a list
   shorter than the declared depth yields an untrusted result rather
   than a fabricated one. Unit tests cover 0, 1, N, over-long, empty,
   malformed, and multi-header cases.
4. **The proxy forwards only vouched values.** A request to `/auth/*`
   carrying a forged `X-Forwarded-For` reaches the upstream with a
   header containing the resolved client and this hop, and not the
   forged entry.
5. **Probes are separated.** `/healthz` answers 200 with the ledger
   driver deliberately broken; `/readyz` answers non-200 in the same
   condition; `/health` matches `/readyz` exactly. The built image
   reports a Docker health status, and `docker inspect` shows the
   `HEALTHCHECK` present.
6. **Metrics are gated by default in the image.** With the token set,
   an unauthenticated scrape is 401 and a correct bearer is 200 with
   the Prometheus content type. With it unset, behavior is unchanged.
   First boot creates the token 0600 and a second boot does not rotate
   it.
7. The full gate is green: `npm run typecheck && npm test`, plus
   `spec-spine compile && spec-spine index && spec-spine lint --fail-on-warn
   && spec-spine index check`.

## 5. Status

**2026-07-25.** Behavior is implemented in full and the gate is green
(`typecheck`, 143 tests across 17 files, `compile`, `index`,
`lint --fail-on-warn`, `index check`). Acceptance items 2, 3, and 7 hold
outright, and item 6's provisioning half is covered by
`docker/first-boot.test.ts`.

One design correction landed during implementation and is recorded in
section 3.1: this spec originally called for `apiRateLimit` on the hiq
service. The extraction gate refused the model, because middleware runs
under the mounting service's attribution, so the limiter's own
`rl:`-prefixed counter writes would have been adjudicated as `hiq` and
denied, and `increment()` fails open on a denial: the limiter would have
enforced nothing while appearing to. The spec was amended before the
code, not after.

Remaining for `implementation: complete`, all of it endpoint-level
proof rather than behavior:

- Items 1 and 4 need an app-level harness (an in-process Encore instance
  serving real requests). No such harness exists in this repo today: the
  suite tests pure modules and subprocess-level integration, and every
  endpoint-level assertion would be the first of its kind. The
  underlying logic is unit-covered (20 identity cases, 10 metrics-auth
  cases); what is missing is the assertion that an unauthenticated
  `POST /hiq/kv` is refused by the running gateway and that a
  non-`demo:` key returns `KERNEL_DENIED`.
- Item 5's ledger-failure and Docker-health-status assertions need a
  built image, which is `image.yml` territory (cron and dispatch only).
- Item 6's 401-and-200 halves need the same harness as item 1.

## 6. Out of scope

- Removing or slot-pruning the hiq demo endpoints. Gating was chosen
  over pruning so the chassis keeps a live, governed exercise of the
  addon; a `hiq_demo` slot remains available to a later contract bump
  if a stamped app wants the surface gone entirely.
- A CIDR allow-list form of trusted-proxy configuration
  (`ENRAHITU_TRUSTED_PROXIES`). Hop counting is sufficient for the
  single-reverse-proxy topology this substrate targets and has no
  parsing surface; a CIDR list is a named extension for the day a
  deployment has heterogeneous ingress.
- Surfacing the transport peer address to typed endpoints. That is an
  Encore runtime capability this repo consumes rather than owns
  (spec 008); until it exists, section 3.2's coarse tier is the honest
  behavior.
- Binding `/metrics` to a separate listener or port. A second listener
  is a packaging change with fleet implications; the bearer token
  delivers the control now.
- mTLS, IP allow-listing, and WAF concerns: deployment-layer, and
  properly the fleet's (statecraft spec 006).
- The operator documentation that sections 3.3 and 3.4 imply
  (probe wiring, scraper configuration, trusted-proxy guidance): spec
  028.

## Closure (2026-07-29): the remaining items, two proved and two superseded

Section 5 left four acceptance items unprovable for one reason: this repo
had no app-level harness, so no test could ask the running gateway
anything. Spec 033 built one. This spec moves to
`implementation: complete`, and the four items resolve in two different
ways, which is worth recording precisely rather than marking them all
"done".

**Item 6, proved.** `/metrics` returns 401 unauthenticated, 401 for a wrong
bearer token, and 200 with Prometheus exposition format for the right one,
asserted against a real gateway with a real token provisioned the way
first-boot provisions one. The provisioning half was already covered by
`docker/first-boot.test.ts`; the serving half now is.

**Items 1 and 4, superseded by removal.** They asked for proof that an
unauthenticated `POST /hiq/kv` is refused and that a non-`demo:` key
returns `KERNEL_DENIED`. Spec 015 retired those endpoints entirely and
dropped the `hiq` service to zero capabilities, so the property now held is
strictly stronger than the one requested: the surface does not exist, and
the service that held the grants holds none.

This is recorded as supersession rather than completion because the
distinction matters for anyone auditing this spec later. The exploit path
in §3.1 was closed twice: first by gating (this spec, 2026-07-25), then by
deletion (spec 015, 2026-07-29). The gating was the right emergency fix and
the deletion is the right end state, and neither makes the other
retrospectively wrong.

The harness asserts the absence rather than dropping the requirement: five
`it.each` cases prove the retired routes 404. A future change that
reintroduces a write surface on this service fails there, which is exactly
where the §3.1 exploit path would otherwise reopen.

**Item 5's ledger-failure and Docker-health-status halves** remain
`image.yml` territory (cron and dispatch only), unchanged by this closure
and not blocking it: they assert packaging behavior, not application
behavior.

One further defect surfaced in the course of closing this spec, and it is
the kind only a booting application reveals: `encore.dev` had drifted a
patch ahead of the napi runtime the toolchain ships (1.57.12 against
1.57.9), and the runtime printed a version-mismatch warning on every boot
that nothing was reading. Pinned in spec 033.
