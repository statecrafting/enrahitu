# @enrahitu/toolchain

The EnRaHiTu build toolchain, distributed as an npm package so a stamped app
carries a readable surface instead of a ~624-file vendored tree (spec 018).

It bundles the vendored Encore build drivers and resolves the two native
binaries they need from per-platform companion packages:

- **Drivers** (bins): `enrahitu-build` (parse + compile + bundle, no `encore`
  CLI), `enrahitu-dev` (build then run the combined bundle under plain node),
  `enrahitu-toolchain` (version report).
- **Native binaries**, delivered as `optionalDependencies` with `os`/`cpu`
  guards (the esbuild/napi-rs pattern): `@enrahitu/toolchain-darwin-arm64`,
  `@enrahitu/toolchain-linux-x64`, `@enrahitu/toolchain-linux-arm64`. Each
  carries `encore-runtime.node` (the Encore napi runtime) and `tsparser-encore`
  (the TS parser/compiler). `npm ci` installs exactly the one matching the host.

## Pinned upstream

This toolchain wraps **encoredev/encore `v1.57.9`** (MPL-2.0). The vendored
Rust source of record lives in the EnRaHiTu template repo under
`vendor/encore/`; these packages are how consumers get prebuilt binaries, not a
replacement for that source. Re-vendoring the hermetic tree is an `npm pack`
away.

## Binary resolution order (spec 018 §3)

`encore-runtime.node` and `tsparser-encore` resolve, in order:

1. an explicit env override (`ENCORE_RUNTIME_LIB` / `ENCORE_TSPARSER_BIN`);
2. the installed platform package under `<cwd>/node_modules` (stamped apps);
3. the in-repo cargo build under `<cwd>/vendor/encore/target/release/`
   (toolchain developers building from source; absent in a stamped tree).

The app root is always the invoking process's cwd.

## Not included

- The Encore **supervisor** binary. EnRaHiTu builds ONE combined bundle (all
  services + the gateway in a single node process; specs 007/008), so there is
  no multi-process orchestration to supervise. It is a conscious non-goal, not
  an omission.
- Windows binaries.
