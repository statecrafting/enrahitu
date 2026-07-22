# enrahitu

**EnRaHiTu**: **En**core.ts + **ra**uthy + **hi**qlite + **Tu**rso/libSQL.
A self-contained, single-container application core with zero
managed-infrastructure dependencies, and the template chassis the
Statecraft factory stamps (spec 009 defines the template contract).
The Encore toolchain (rust runtime core, TS parser/compiler) is consumed as
the published `@statecrafting/toolchain` package and driven directly via
napi-rs; the `encore` CLI is not used anywhere (spec 008). Lineage:
formerly `enrahi` / `enrahi-kit`; the kit variant is now the only
variant, renamed to credit the fourth load-bearing ingredient.

One Docker image + one volume = a complete authenticated application:

- **Encore.ts** application framework (self-hosted, no Encore cloud, no
  Encore CLI: the @statecrafting toolchain builds and runs the app)
- **rauthy** OIDC identity provider, shipped inside the same container
- **hiqlite** in-process (napi-rs native addon): cache/KV + counters, no Redis
- **CoreLedger** durable data on libSQL: local SQLite file by default, Turso
  embedded-replica sync optional, managed Postgres behind the same decorator
  API when scale demands it

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design record and
phase plan.

## Development

```bash
npm install            # installs @statecrafting/toolchain + hiqlite-native (prebuilt binaries)
npm run dev            # build + run on :4000 under plain node

curl localhost:4000/health
curl localhost:4000/hiq/health
curl -X POST localhost:4000/hiq/kv -H 'content-type: application/json' \
  -d '{"key":"hello","value":"world","ttlSecs":60}'
curl localhost:4000/hiq/kv/hello
curl localhost:4000/metrics   # Prometheus text format, always on (spec 022)
```

OTel traces are on in-process (a bounded recent-trace buffer the admin
dashboard reads); set `OTEL_EXPORTER_OTLP_ENDPOINT` to ship spans to
a collector. Unset means no exporter and no outbound connection.

The flag-gated operator dashboard (spec 023) serves same-origin at
`/admin` (build it with `npm run build:web-admin`), gated server-side on
the `enrahitu_operator` role; `ADMIN_UI_ENABLED=false` is the runtime
kill switch, and the template.toml `admin` slot prunes it at stamp time.

Requires Node >= 24. The toolchain and the hiqlite addon arrive as prebuilt
per-platform binaries, so no Rust, cargo, or protoc is needed. The Encore CLI
is NOT required.

## License

Apache-2.0 (see [LICENSE](LICENSE)). The Encore toolchain arrives as the
published `@statecrafting/toolchain` packages; its vendored MPL-2.0 Encore core
lives in that repo, not here. Apps stamped from this template inherit Apache-2.0
code only where they copy it and are otherwise unencumbered: generated
applications belong to their owners.
