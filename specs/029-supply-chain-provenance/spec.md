---
id: "029-supply-chain-provenance"
title: "Supply-chain provenance: signed, described, and installable offline"
status: approved
created: "2026-07-25"
implementation: pending
depends_on:
  - "012-born-with-provenance"
  - "016-amd64-image"
  - "027-operational-verbs"
establishes:
  - "scripts/airgap-bundle.sh"
summary: >
  Spec 012 established born-with provenance for the repository: a
  stamped app can prove what generated it and under what agentic
  posture. The artifact that repository produces carries none of that.
  image.yml pushes to GHCR unsigned and unattested, with no SBOM and no
  offline install path, so the chain of custody the template is careful
  about ends exactly where a buyer's security review begins. This spec
  extends provenance from the repo to the image: cosign keyless
  signatures, an SPDX SBOM published as an attestation, and a docker
  save bundle with a verification script so a cell can be installed on a
  host with no outbound network. The buyer persona that wants a
  self-contained image is disproportionately the persona that has no
  egress, so the air-gap path is not an edge case for this substrate; it
  is the main case arriving late.
---

# 029: Supply-chain provenance

## 1. Purpose

The template is unusually rigorous about provenance in the repository
and entirely silent about it in the artifact.

Spec 012 defines a born-with certificate, a schema, a validator, and an
agentic-posture binding, all reachable through `template.toml`'s
`[provenance]` table. Spec 024 hash-chains and signs every governance
Decision. Spec 021 boots fail-closed on a model whose integrity does not
check. That is a coherent and genuinely differentiated position on
custody, and it stops at `docker push`.

`.github/workflows/image.yml` builds per-arch images, smokes them,
pushes them under a SHA-scoped tag, and stitches a multi-arch manifest.
Nothing signs them. Nothing describes their contents. A consumer pulling
`ghcr.io/<owner>/enrahitu:latest` has no way to establish that it came
from this repository's CI rather than from anyone with push rights, and
no machine-readable statement of what is inside it.

The gap matters most for exactly the buyer this substrate targets. An
organization that wants one self-contained image on its own hardware
usually wants it because the hardware has no outbound network, and it
usually has a security review that asks for an SBOM by name. Today the
build pulls `ghcr.io/sebadob/rauthy:0.36.0` and npm packages from the
registry at build time, and ships no bundle, so the answer to "install
this on an air-gapped host" is that you cannot.

## 2. Territory

This spec owns `scripts/airgap-bundle.sh`: the offline bundle producer
and its verification counterpart.

It amends, without owning, `.github/workflows/image.yml` (spec 016): the
signing, attestation, and bundle-publication steps in sections 3.1
through 3.3.

## 3. Behavior

### 3.1 Signatures

cosign keyless signing over the OIDC identity GitHub Actions already
provides, so there is no key to manage, rotate, or leak. Every pushed
tag is signed: the per-arch SHA-scoped tags and the multi-arch manifest.

Verification is documented as a command a consumer runs before
installing, with the expected identity and issuer stated explicitly.
An unverifiable image is a refusal, and the documentation says so in
those terms rather than presenting verification as optional hygiene.

### 3.2 The SBOM

An SPDX SBOM generated from the final image and published as a cosign
attestation attached to it, so the description travels with the artifact
rather than beside it.

The SBOM covers what the image actually contains, which for this
substrate is a specific and unusually interesting list: the node base,
the app bundle, the rauthy binary copied from its upstream image, the
prebuilt Encore runtime and tsparser binaries from
`@statecrafting/toolchain`, the hiqlite and kernel native addons, and
the built SPA bundles. Several of those are prebuilt binaries with their
own upstream provenance, which is precisely the thing a reviewer wants
enumerated.

The rauthy binary's own version and origin are recorded explicitly,
since it enters the image by `COPY --from` and would otherwise be
invisible to a scanner that only reads package manifests.

### 3.3 The air-gap bundle

`scripts/airgap-bundle.sh` produces one directory, and a `.tar.gz` of
it, containing everything needed to install with no network:

- the multi-arch image as a `docker save` archive,
- its cosign signature and SBOM attestation,
- a checksum manifest over every member,
- `verify.sh`, which checks the checksums and, when cosign is present,
  the signature, and which states clearly what it could and could not
  verify rather than passing silently on a missing tool,
- the operator documentation (spec 028) for the exact version in the
  bundle, because an air-gapped operator cannot read documentation on a
  website.

The bundle is produced by CI on release and published as a release
asset. Its checksum manifest is signed by the same keyless flow, so the
bundle inherits the chain rather than starting a new one.

### 3.4 The build's own egress, stated

This spec does not make the build hermetic; that is a larger change and
a different concern. It does make the build's inputs explicit: the
pinned rauthy image digest (not merely its tag), the toolchain package
versions, and the base image digest are recorded in the SBOM and in the
build metadata, so an auditor can see exactly what was pulled even
though the build pulled it.

Pinning `ghcr.io/sebadob/rauthy` by digest rather than by the current
`0.36.0` tag is the one behavioral change to the build here, and it is
worth the friction: a tag is mutable and this substrate's whole claim is
about custody.

## 4. Acceptance

1. Every image tag pushed by `image.yml` carries a verifiable cosign
   signature; `cosign verify` with the documented identity and issuer
   succeeds, and succeeds against the multi-arch manifest as well as the
   per-arch tags.
2. An SPDX SBOM is attached as an attestation and enumerates the node
   base, the rauthy binary with its version and source digest, both
   `@statecrafting` native addons, the Encore runtime and tsparser
   binaries, and the SPA bundles.
3. `scripts/airgap-bundle.sh` produces a bundle that installs a working
   cell on a host with no outbound network, verified by building the
   bundle, running the install on a network-isolated container, and
   reaching a successful login.
4. `verify.sh` fails on a tampered member and reports precisely which
   member failed; with cosign absent it reports that the signature was
   not checked rather than exiting zero silently.
5. The rauthy base is pinned by digest, and the digest appears in both
   the Dockerfile and the SBOM.
6. A release run publishes the bundle and its signed checksum manifest
   as release assets.
7. Coupling gate green.

## 5. Out of scope

- A hermetic or fully offline build. The build still pulls from GHCR and
  npm; this spec records what it pulls rather than eliminating the pull.
- SLSA provenance attestation beyond what cosign keyless plus the SBOM
  deliver. A named extension once a consumer asks for a specific level.
- Signing the stamped application repositories the factory produces.
  That is spec 012's territory and the factory's, not the image's.
- Vulnerability scanning and a CVE policy. The SBOM makes scanning
  possible; deciding what to do about findings is an operational policy
  this template does not set for its consumers.
- Mirroring npm and GHCR for air-gapped rebuilds. The bundle installs a
  built image; rebuilding from source offline is a different and much
  larger requirement.
