# enrahitu

**EnRaHiTu**: **En**core.ts + **ra**uthy + **hi**qlite + **Tu**rso/libSQL.
A self-contained, single-container application core with zero
managed-infrastructure dependencies, and the template chassis the
Statecraft factory stamps (spec 009 defines the template contract).
The Encore toolchain (rust runtime core, TS parser/compiler, encore.dev
JS runtime) is vendored under `vendor/encore/` and driven directly via
napi-rs; the `encore` CLI is not used anywhere (spec 008). Lineage:
formerly `enrahi` / `enrahi-kit`; the kit variant is now the only
variant, renamed to credit the fourth load-bearing ingredient.

One Docker image + one volume = a complete authenticated application:

- **Encore.ts** application framework (self-hosted, no Encore cloud, no
  Encore CLI: the vendored toolchain builds and runs the app)
- **rauthy** OIDC identity provider, shipped inside the same container
- **hiqlite** in-process (napi-rs native addon): cache/KV + counters, no Redis
- **CoreLedger** durable data on libSQL: local SQLite file by default, Turso
  embedded-replica sync optional, managed Postgres behind the same decorator
  API when scale demands it

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design record and
phase plan.

## Development

```bash
npm run build:addon    # build the hiqlite-native addon (Rust, ~2 min)
npm run build:runtime  # build the vendored Encore toolchain (Rust, one-time)
npm install
npm run dev            # build + run on :4000 under plain node

curl localhost:4000/health
curl localhost:4000/hiq/health
curl -X POST localhost:4000/hiq/kv -H 'content-type: application/json' \
  -d '{"key":"hello","value":"world","ttlSecs":60}'
curl localhost:4000/hiq/kv/hello
```

Requires Node >= 24, Rust (stable), and protoc (`brew install protobuf`).
The Encore CLI is NOT required.

## License

Apache-2.0 (see [LICENSE](LICENSE)). Exception: `vendor/encore/` carries
upstream [encoredev/encore](https://github.com/encoredev/encore) @ v1.57.9,
which remains under the Mozilla Public License 2.0
(see [vendor/encore/LICENSE](vendor/encore/LICENSE)); the MPL is file-level
and coexists with the Apache-2.0 siblings. Apps stamped from this template
inherit Apache-2.0 code only where they copy it and are otherwise
unencumbered: generated applications belong to their owners.
