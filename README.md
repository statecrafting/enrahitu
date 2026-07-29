# enrahitu

A **membership and association management platform** for non-profits and
associations: members, tiers, renewals, dues, events, registrations,
volunteers, documents, board governance, announcements, and threaded
discussion. Self-hosted, with the organization's own identity provider,
shipped as a working application that organizations extend rather than
fork. It is also the template chassis the Statecraft factory stamps
(spec 009 defines the template contract).

The Encore toolchain (rust runtime core, TS parser/compiler) is consumed as
the published `@statecrafting/toolchain` package and driven directly via
napi-rs; the `encore` CLI is not used anywhere (spec 008). Lineage:
formerly `enrahi` / `enrahi-kit`. The name is a proper noun: its former
expansion (Encore + rauthy + hiqlite + Turso) stopped describing the stack
when Turso was benched.

One container + one volume = a complete authenticated application. Layer
ownership, with no overlap:

- **Encore.ts** holds the edge: API surface, contracts, generated clients,
  and the external seams declared in `infra.config.json`. Self-hosted, no
  Encore cloud, no Encore CLI.
- **rauthy** holds identity: authentication and principal identity, reached
  only through the app's own origin, consumed at its API surface and never
  forked.
- **hiqlite** holds state and coordination, in-process via a napi-rs addon.
  Raft runs with a single voter at N=1 and with three or five when a tenant
  outgrows one box.
- **Application code** holds intent and reconciliation: typed,
  tenant-scoped resources admitted through a kernel, with a hash-chained
  Decision ledger recording every admitted mutation.

**N=1 is the primary mode**, not a degenerate case: one container, one
volume, one command, no external infrastructure, and that is what most
deployments run forever. The corpus is mid-pivot toward this shape; spec
001 §5.2 records the disposition of every spec, and §5.1 the phases.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design record and
phase plan.

## Development

```bash
docker compose -f docker/compose.yml up   # the N=1 dev topology: app + rauthy,
                                          # one container, one volume, watched

npm install            # installs @statecrafting/toolchain + hiqlite-native (prebuilt binaries)
npm run check:licenses # the AGPL boundary guard (spec 001 §4.7)

curl localhost:4000/healthz   # liveness; touches no dependency (spec 025)
curl localhost:4000/readyz    # readiness; checks the ledger
curl localhost:4000/hiq/health
curl localhost:4000/metrics -H "Authorization: Bearer $ENRAHITU_METRICS_TOKEN"
```

The `/hiq/kv` and `/hiq/counter` endpoints are operator-gated (spec 025):
they need a session carrying the `enrahitu_operator` role, so a bare curl
gets a 401 by design. That surface is a demo and retires once application
code reaches hiqlite directly.

**Development is docker-only** (spec 001 §4.1). `docker compose up` runs the
same topology the packaged image runs, under the same `entrypoint.sh` with the
same supervision, differing only in that source is mounted and rebuilt on
change. `npm run dev` still works and runs the app on the host, but it is the
pre-pivot shape and the divergence it created is what spec 033 exists to close.

OTel traces are on in-process (a bounded recent-trace buffer the admin
dashboard reads); set `OTEL_EXPORTER_OTLP_ENDPOINT` to ship spans to
a collector. Unset means no exporter and no outbound connection.

The flag-gated operator dashboard (spec 023) serves same-origin at
`/admin` (build it with `npm run build:web-admin`), gated server-side on
the `enrahitu_operator` role; `ADMIN_UI_ENABLED=false` is the runtime
kill switch, and the template.toml `admin` slot prunes it at stamp time.

Requires Node >= 24 and docker. The toolchain and the hiqlite addon arrive as
prebuilt per-platform binaries, so no Rust, cargo, or protoc is needed. The
Encore CLI is NOT required and is not used anywhere.

## License

Apache-2.0 (see [LICENSE](LICENSE)). The Encore toolchain arrives as the
published `@statecrafting/toolchain` packages; its vendored MPL-2.0 Encore core
lives in that repo, not here. Apps stamped from this template inherit Apache-2.0
code only where they copy it and are otherwise unencumbered: generated
applications belong to their owners.
