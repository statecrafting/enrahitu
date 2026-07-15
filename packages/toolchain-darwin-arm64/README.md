# @enrahitu/toolchain-darwin-arm64

Prebuilt EnRaHiTu toolchain binaries for **macOS arm64**:

- `encore-runtime.node` : the Encore napi runtime
- `tsparser-encore` : the Encore TS parser/compiler

Both are built from `encoredev/encore` **v1.57.9** (MPL-2.0). This package is a
platform-guarded (`os`/`cpu`) `optionalDependency` of
[`@enrahitu/toolchain`](https://www.npmjs.com/package/@enrahitu/toolchain);
`npm ci` installs it only on a matching host. The binaries are populated by the
publish workflow (spec 018) and are not tracked in git.
