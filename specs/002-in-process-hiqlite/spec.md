---
id: "002-in-process-hiqlite"
title: "In-process hiqlite via a napi-rs native addon"
status: approved
created: "2026-07-14"
implementation: complete
origin:
  retroactive: true   # phase 0 shipped before the spec graph existed
depends_on:
  - "001-enrahitu-architecture"
establishes:
  - { kind: directory, path: "backend/hiq/" }
summary: >
  The hiqlite runtime embedded in the Node process: a napi-rs cdylib
  (@enrahitu/hiqlite-native) exposing init/health, TTL'd KV, and counters,
  plus the thin `hiq` Encore service that starts the node at service load
  and fronts the addon over HTTP. Replaces Redis for cache and rate-limit
  state with zero extra processes.
---

# 002: In-process hiqlite

## 1. Purpose

Cache/KV and counters without Redis and without a sidecar: hiqlite runs
inside the application process as a native addon. rauthy (spec 005) brings
its own embedded hiqlite, so the entire stack stays in the SQLite family.

## 2. Territory

- `addon/`: the Rust crate (`hiqlite-native`, napi-rs cdylib) and its npm
  packaging (`@enrahitu/hiqlite-native`). hiqlite is pinned `=0.14.0` with
  features `cache,counters,macros` (no SQLite-C). Cross-built for the image
  target (`linux-arm64-gnu` / `linux-x64-gnu`) because `encore build docker`
  does not compile Rust; the built `.node` artifacts and the napi-generated
  loader are gitignored (`addon/.gitignore`) and injected into the image
  worktree by spec 007's build script, which fails loudly when they are
  missing.
- `backend/hiq/`: the Encore service over the addon. `backend/hiq/init.ts`
  starts the hiqlite node at service load, not lazily (template-encore PR #40
  caveat 5). The addon stays at the repo root (`addon/`) as chassis source,
  outside `backend/` (spec 019).

## 3. Behavior

- Addon surface: `init`, `health`, `kvPut` / `kvGet` / `kvDel` (TTL),
  `counterAdd` / `counterGet` / `counterSet` / `counterDel`.
- Configuration via `ENRAHITU_HIQ_*` env vars (data dir, raft/api bind
  addresses, secrets). In the packaged container the entrypoint assigns
  ports 8300/8400 because rauthy's embedded hiqlite owns 8100/8200 in the
  same network namespace (spec 007).
- HTTP surface (`hiq` service): `GET /hiq/health`, `POST /hiq/kv`,
  `GET|DELETE /hiq/kv/:key`, `POST /hiq/counter/:key/add`,
  `GET /hiq/counter/:key`.
- As built today, the addon enables `cache` + `counters` and the node
  runs with a single voter. This is the shipped configuration, not a
  ceiling; see the 2026-07-27 pivot note.

## 4. Out of scope

- The expanded addon surface (replicated SQL, dlock, listen/notify,
  cluster configuration) is not described here because it does not exist
  yet. It is specified by the interface contract and built in phase 2
  (spec 001 §5.1); this spec is rewritten when that surface lands.

## 5. Publishing (amended by spec 018, 2026-07-14)

The addon keeps its package name `@enrahitu/hiqlite-native` and gains a
registry publish path so a stamped app installs a prebuilt binary instead of
copying the crate. The napi loader (`index.js`) already falls back to
per-platform packages `@enrahitu/hiqlite-native-<triple>`, so the manifest
drops `private`, and the spec 018 publish workflow
(`.github/workflows/publish.yml`) builds the three platform packages
(`darwin-arm64`, `linux-x64-gnu`, `linux-arm64-gnu`) via
`napi create-npm-dirs`/`artifacts` and injects them into the published meta
manifest as `optionalDependencies` at publish time. They are NOT committed to
`addon/package.json`: declaring them there churns `addon/package-lock.json`
across platforms (the transitive emnapi optional tree), which would break
`npm ci` in `verify.yml`. This repo still resolves the addon through the
`file:./addon` dependency and the locally built (gitignored) `.node`;
publishing is additive, not a replacement for the in-tree dev path.

## 6. Phase A seam (amended by spec 021, 2026-07-20)

The raw addon is no longer imported by consumers directly. `hiq/init.ts`
keeps the module-load `init()` side effect and remains the only importer
of `@enrahitu/hiqlite-native`, but its default export is consumed solely
by the governed facade `backend/kernel/hiq.ts` (spec 021), which
adjudicates every kv/counter operation against the app model before
crossing into Rust. The `hiq` service endpoints and the rate limiter
(spec 004) call the facade, never the addon; the extraction ban-list
enforces both rules at build time.

The addon meta manifest carries a `repository` field pointing at this repo
(`github.com/statecrafting/enrahitu`): `npm publish --provenance` rejects a
package whose `repository.url` does not match the GitHub source recorded in
the signed provenance bundle. `napi create-npm-dirs` copies `repository` into
each generated `@enrahitu/hiqlite-native-<triple>` manifest, so it is declared
once in `addon/package.json`; the generated `addon/npm/` tree is a build
artifact and gitignored.

## Amendment (2026-07-21): the addon moves to @statecrafting/hiqlite-native

The napi addon left this tree. `addon/` is deleted here and the hiqlite
capability is now consumed as the published `@statecrafting/hiqlite-native`
(statecrafting spec 003), a byte-identical move of the same Rust crate under a
scope that describes its ownership: the addon is shared substrate for enrahitu
and statecraft, not enrahitu's alone. `backend/hiq/init.ts` imports the new
specifier; `backend/hiq/` (the `hiq` service + facade) stays here, so this spec
keeps that edge and drops only `addon/`. The build-time import ban that kept raw
addon imports out of everything but `backend/hiq/init.ts` now lives in the
published toolchain's extractor and targets the new specifier. No spec retires:
this remains the design record of the in-process hiqlite capability.

## Amendment (2026-07-22): observability seam (spec 022)

The hiq service mounts spec 022's `obsMiddleware` (its only
middleware): every `/hiq/*` endpoint gets a request span and the
request metrics families. Facade semantics and the kernel adjudication
seam are unchanged.

## Amendment (2026-07-25): the demo surface is operator-gated (spec 025)

The six `/hiq/*` endpoints shipped `expose: true` with no `auth: true`,
and the service mounted `obsMiddleware` alone. That was correct while the
surface was a developer's laptop and wrong once the packaged image binds
`0.0.0.0:8080`: it published unauthenticated writes into the
raft-replicated store, and, because this service also held an
unconstrained `cap.counter.add`, it published the rate limiter's own
counters. Spec 025 §3.1 has the detail and the exploit path.

The five data endpoints (`kvPut`, `kvGet`, `kvDel`, `counterAdd`,
`counterGet`) now take `auth: true` and check the `<app>_operator` role.
`GET /hiq/health` stays public: it returns a status string, leaks
nothing, and is the probe the image smoke curls.

The service mounts `[obsMiddleware, securityHeaders, csrfMiddleware]`,
the admin service's chain rather than the auth service's. `apiRateLimit`
is deliberately absent: middleware runs under the mounting service's
kernel attribution, so the limiter's `rl:`-prefixed writes would be
adjudicated as `hiq`, denied against this service's `demo:`-scoped
grants, and swallowed by the limiter's fail-open path, enforcing nothing.
An operator-only surface behind a role gate does not need it.

The addon facade, the init path, and the Phase A seam are unchanged.

## Pivot (2026-07-27): two invariants deleted, nothing added

This spec carried two prohibitions that the pivot (spec 001 §2) makes
false. They are deleted here, in phase 0, ahead of any code, because an
approved spec asserting them would make every phase 2 spec read as
contradicting the corpus rather than extending it:

- **"hiqlite runs single-node."** Deleted. hiqlite is the state layer,
  and N=3 or N=5 Raft is the scale path (spec 001 §4.1, spec 030). N=1
  remains the primary mode and the default deployment, which is a
  statement about defaults, not about capability.
- **"Clustering (StatefulSet raft) is out of scope for v0."** Deleted.
  hiqlite already solves bootstrap, auto-join, ordinal identity
  (`node_id_from = "k8s"`), and learners (`HQL_LEARNER_ONLY`); what is
  missing from the addon is configuration passthrough, not consensus
  code.
- **"dlock and listen/notify: added only when a consumer exists."** The
  condition is now met: controllers need leases and watch. Both features
  resolve to `["cache"]` in hiqlite's `Cargo.toml`, which is already
  enabled, so they are nearly free.

**Deliberately not done here.** The expanded surface is not written into
this spec, and the pin, the feature list, and the "no bundled SQLite-C"
property in section 2 still describe what is actually built. This spec is
`implementation: complete`, and a complete spec that describes unbuilt
behavior is a claim the coupling gate cannot catch. Deleting a false
prohibition and describing an unbuilt target are different operations;
only the first belongs in phase 0.

For the record, so the phase 2 rewrite is not a surprise: enabling the
`sqlite` feature pulls `rusqlite`, `deadpool`, and `serde_rusqlite`, which
compiles SQLite-C into the `.node` on all three platforms and ends the
addon's current no-bundled-SQLite-C property. That cost is accepted, and
it buys `backup = ["dep:cron", "s3", "sqlite"]` in the same change, which
is the product's durability story rather than a side effect.

## Amendment (2026-07-29): the HTTP demo surface retires

The five data endpoints (`kvPut`, `kvGet`, `kvDel`, `counterAdd`,
`counterGet`) are deleted. `GET /hiq/health` remains, public and
unauthenticated, because it returns a status string, leaks nothing, and is
the probe the image smoke test curls (spec 007).

Spec 025 gated these endpoints behind the operator role and narrowed their
grants to a `demo:` prefix, which was the right emergency fix. This is the
correct end state: **hiqlite is a library, not an API.** Publishing the
governed facade over HTTP added a second, weaker path to the same store
and put six endpoints into the app model and the operator catalog that no
feature used. Application code reaches hiqlite in-process through
`backend/kernel/hiq.ts`, which adjudicates every operation against the
model before crossing into Rust. That was always the intended shape; the
endpoints were a demonstration that outlived its purpose.

Retiring them here, in the change that deletes the SPA's cache-demo widget
(spec 015), is deliberate: the widget was the only consumer, so this is
the moment the surface has no user rather than a moment it merely has no
justification.

**The hiq service now holds zero capabilities** in `app-manifest.json`,
and the five `demo:`-scoped capability definitions are deleted with it.
That is the true end of the spec 025 §3.1 exploit path: the service that
once held an unconstrained `cap.counter.add`, and could therefore forge
the rate limiter's own buckets, can no longer reach the store through the
kernel at all. `health()` demands nothing, so nothing needs granting, and
any endpoint added here later starts from zero and must justify each grant
it asks for.

Unchanged: `backend/hiq/init.ts` (the module-load `init()` that starts the
node before any service handles a request), the kernel facade, and the
Phase A seam. Those are the capability. The endpoints were the demo.

## Amendment (2026-07-30): reclaiming a state machine whose owner is gone

`backend/hiq/init.ts` now clears a stale state-machine lock before it starts
the node, and records which process owns the data directory so a later start
can tell "stale" from "in use". `backend/hiq/lock.ts` holds the decision.

**The defect.** hiqlite writes `<data>/state_machine/lock` when the SQLite
state machine opens and removes it in exactly one place, `Client::shutdown()`.
The addon does not expose `shutdown()` and nothing here has ever called it, so
the lock is never released: not on SIGTERM, not on a clean `docker compose
stop`, not between the watch loop's rebuilds. Every start after the first finds
it and panics.

```
Lock file already exists: /data/hiqlite/state_machine/lock
Node did not shut down gracefully - needs manual interaction
```

The message means what it says. A human deletes a file inside the container,
or the store stays shut.

**Why this reads as a development papercut and is not one.** Spec 036 §3.2
keeps a store that will not open from taking down `/healthz`, the admin
dashboard, and the login flow with it. That is the right behavior and it is
also excellent camouflage: the symptom is `/readyz` answering 500 on a
container whose liveness probe is green, and it survives every restart, because
each restart leaves the lock exactly as it found it. Under the watch loop it
arrives on the *first* edit of a session, since a rebuild stops and restarts
the app process; the container log for 2026-07-30 carries the panic after
nearly every rebuild, for hours. Under a restart policy it arrives after any
hard kill and never clears on its own. A deployment whose thesis is one
container and one volume cannot require a human with a shell after an OOM.

**Why not simply delete the lock at boot.** The lock is load bearing. Two
processes opening one SQLite state machine is corruption, and this panic is the
only thing standing between a mistake and that outcome. Deleting it
unconditionally trades a recoverable outage for an unrecoverable one. The
question is therefore not whether to remove the lock but whether it is
*provably* stale, and hiqlite's own lock file cannot answer that: it is zero
bytes and names no owner.

**The decision: supply the missing half.** Every node start writes
`enrahitu-owner.json` (pid, hostname, timestamp) at the data-dir root, before
`init()` rather than after, so a node that dies during startup still leaves the
evidence its successor needs. A start that finds a lock then asks whether that
owner is still alive:

- **no lock**: nothing to reclaim; record ownership and continue.
- **lock, owner is a live process on this host**: a second node is genuinely
  starting against a directory in use. Keep the lock and let hiqlite panic.
  That panic is correct and this is the case it exists for.
- **lock, owner is gone**: provably stale. Clear it and continue.
- **lock, owner recorded on a different host**: its pid means nothing in this
  namespace, so staleness cannot be proven. Keep the lock.
- **lock, no owner record**: a volume written before this code existed, so no
  live process ever recorded ownership of it. Clear it, once. Every start from
  here on leaves a record, so the case does not recur.

Liveness is signal 0, which performs the existence and permission checks
without delivering anything; EPERM counts as alive, being a process that is
there and simply not ours to signal. The owner record sits at the data-dir root
rather than beside the lock inside `state_machine/`, because hiqlite chmods
that directory during `build_folders` and there is no reason to hand it a file
it did not create.

**The recovery may never throw.** It runs at module load, so an exception is
not a failed recovery: it is a failed import, taking down a process that would
otherwise have started, served `/healthz`, and reported the store's condition.
That inverts spec 036 §3.2 and would make a store that will not open strictly
worse than before this code existed. A read-only volume or a lock owned by
another uid reaches that path through `rmSync`, which honours `force` for a
missing file and not for a permission denial. Every outcome is therefore a
returned value, including the failure to decide, and a recovery that cannot run
leaves the question to hiqlite exactly as it sat before.

**What this does not fix**, and the distinction matters: releasing the lock on
the way down. That is the actual defect, it lives in the addon, and spec 032's
implementation record for the same date files it as the contract hole it is.
Recovery is still needed after that lands, because SIGKILL, the OOM killer, and
power loss are not going anywhere.

Verified against the running N=1 container rather than argued: a volume
carrying a legacy lock recovered through the `no-owner-record` path, the next
restart through `owner-gone`, and three consecutive watch-loop rebuilds each
logged the reclaim and then `members: runtime started`, where before this
change the first rebuild of a session ended the domain until a human intervened.
