# enrahitu

A **membership and association management platform** for non-profits and
associations: members, tiers, renewals, dues, events, registrations,
volunteers, documents, board governance, announcements, and threaded
discussion. Self-hosted, with the organization's own identity provider,
shipped as a working application that organizations extend rather than fork.

**One container + one volume = a complete authenticated application.** No
sidecars, no managed database, no secret-management prerequisite, no cloud
account. That is the deployment unit, and for most organizations it is the
whole deployment forever.

## Run it

```bash
docker volume create enrahitu-data

docker run -d --name enrahitu \
  -v enrahitu-data:/data \
  -p 8080:8080 \
  -e ENRAHITU_PUBLIC_URL=http://localhost:8080 \
  enrahitu:latest

# The admin account and its generated password are printed once, on first boot.
docker logs enrahitu | grep '\[first-boot\] rauthy admin'
```

Then read **[docs/OPERATIONS.md](docs/OPERATIONS.md)** before putting it in
front of anyone: it covers TLS and reverse proxies (the single most likely
installation failure), probes, backup and restore, upgrades, and a
troubleshooting table.

## What you get in the one container

- **The application**: the membership domain, a React 19 SPA, and a
  same-origin API.
- **Your own identity provider.** rauthy runs inside the image and is reached
  only through the app's origin. Authentication is yours; no third-party IdP,
  no per-seat pricing, no second origin to configure.
- **Durable state with no database to run.** hiqlite runs in-process via a
  napi-rs addon and holds state and coordination; CoreLedger holds relational
  application data in a local SQLite file.
- **A governance plane.** Typed, tenant-scoped resources are admitted through a
  kernel, and every admitted mutation lands on a hash-chained Decision ledger.
- **Operations that exist.** Liveness and readiness probes, token-authenticated
  Prometheus metrics, tracing, an operator dashboard, and verbs for pre-flight,
  migrate, backup, and restore.

**N=1 is the primary mode**, not a degenerate case: one container, one volume,
one command. Three or five nodes is the additional case.

## Development

For contributors to the substrate itself. If you only want to *run* enrahitu,
the section above and `docs/OPERATIONS.md` are what you need.

```bash
npm install            # @statecrafting/toolchain + hiqlite-native (prebuilt binaries)
docker compose -f docker/compose.yml up   # the N=1 dev topology: app + rauthy, watched

npm test               # vitest
npm run typecheck
npm run check:licenses # the AGPL boundary guard
```

Development is docker-only (spec 001 §4.1). `docker compose up` runs the same
topology the packaged image runs, under the same `entrypoint.sh` with the same
supervision, differing only in that source is mounted and rebuilt on change.
`npm run dev` still works and runs the app on the host, but it is the pre-pivot
shape and the divergence it created is what spec 033 exists to close.

Probing a running dev cell:

```bash
curl localhost:4000/healthz   # liveness; touches no dependency
curl localhost:4000/readyz    # readiness; checks the ledger and hiqlite
curl localhost:4000/hiq/health
curl localhost:4000/metrics -H "Authorization: Bearer $ENRAHITU_METRICS_TOKEN"
```

`/hiq/kv` and `/hiq/counter` are operator-gated: they need a session carrying
the `enrahitu_operator` role, so a bare curl gets a 401 by design. That surface
is a demo and retires once application code reaches hiqlite directly.

Requires Node >= 24 and docker. The toolchain and the addon arrive as prebuilt
per-platform binaries, so no Rust, cargo, or protoc is needed. The Encore CLI
is **not** required and is not used anywhere (spec 008).

## Where to go next

- **[docs/OPERATIONS.md](docs/OPERATIONS.md)**: running it. Install, TLS,
  probes, metrics, mail, backup and restore, upgrade, sizing, troubleshooting.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**: understanding it. The
  layers, the five planes, and the key decisions.
- **`specs/`**: why. Every substantive decision is recorded in a spec;
  `specs/001-enrahitu-architecture/spec.md` is the thesis.

enrahitu is also the template chassis the Statecraft factory stamps (spec 009
defines the versioned template contract). Your code lives in `app/`, the one
directory an upgrade never touches (spec 035).

## License

Apache-2.0 (see [LICENSE](LICENSE)). The Encore toolchain arrives as the
published `@statecrafting/toolchain` packages; its vendored MPL-2.0 Encore core
lives in that repo, not here. Apps stamped from this template inherit
Apache-2.0 code only where they copy it and are otherwise unencumbered:
generated applications belong to their owners.
