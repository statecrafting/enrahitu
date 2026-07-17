---
id: "012-born-with-provenance"
title: "Born-with certificate + agentic posture binding (LI-2)"
status: approved
created: "2026-07-14"
implementation: complete
depends_on:
  - "009-template-contract"
establishes:
  - ".statecraft/born-with.schema.json"
  - "scripts/verify-born-with.mjs"
  - "scripts/verify-born-with.test.ts"
  - "scripts/fixtures/born-with.example.json"
summary: >
  Every stamped app is born with a provenance certificate that states, at
  the moment of stamping, what it was stamped from and what agentic
  posture it was born under. The template owns the certificate's schema
  and its validator; the factory (statecraft) owns emission. This lands
  the reserved [provenance] contract table from spec 009 §3.3 and is
  absorption line item LI-2 of spec 010. Lineage: the born-with cert +
  agenticPostureBinding flow proven in the template-encore era; the
  design facts an implementer needs are inlined here, no external
  archive required.
---

# 012: Born-with certificate + agentic posture

## 1. Purpose

Two governance claims must be checkable on any stamped repo forever
after, without asking the platform: "what exactly was this stamped
from?" and "what agentic posture was it born under?". The certificate
answers both, locally, from the repo's own tree. The posture binding is
always explicit: a cert that omits it or marks it defaulted is invalid
by schema, because a silently defaulted posture is the failure mode the
lineage design existed to kill.

## 2. Territory

- `.statecraft/born-with.schema.json`: JSON Schema (draft 2020-12) for
  the certificate.
- `scripts/verify-born-with.mjs`: validator invoked as
  `node scripts/verify-born-with.mjs [path]` (default
  `.statecraft/born-with.json`); exit 0 valid, exit 1 with reasons.
- `scripts/verify-born-with.test.ts` +
  `scripts/fixtures/born-with.example.json`: the acceptance suite and a
  well-formed fixture cert (a test artifact, not the repo's own
  instance), driving the validator through its CLI.
- Amends `template.toml` (owned by spec 009; edit both specs together):
  add the `[provenance]` table and bump `[contract].version` to `0.3.0`.

The certificate *instance* (`.statecraft/born-with.json`) exists only in
stamped repos, written by the factory at stamp time; the template repo
itself carries no instance.

## 3. Certificate shape (v1)

```json
{
  "certVersion": "1",
  "app": { "name": "<app_name slot>", "org": "<org slot>" },
  "template": {
    "name": "enrahitu",
    "version": "<template.toml [template].version>",
    "contractVersion": "<template.toml [contract].version>",
    "commit": "<full SHA of the template commit stamped from>"
  },
  "agenticPostureBinding": {
    "posture": "none | assisted | autonomous",
    "defaulted": false
  },
  "stampedAt": "<ISO 8601 UTC>",
  "stampedBy": { "kind": "factory | manual", "id": "<actor identifier>" }
}
```

Rules the schema must enforce: all fields required; `defaulted` must be
literally `false` (a cert admitting a defaulted posture is invalid);
`posture` is the closed enum above; `commit` is a 40-hex string.

## 4. Canonical form and hash

The certificate's canonical form is its JSON serialized with object keys
recursively sorted lexicographically (byte order), UTF-8, no
insignificant whitespace. Its identity hash is sha256 over those bytes.
This matches the canonical-keysort-json crate's semantics
(github.com/statecraft-ing lineage: "recursive lexicographic sort of
object keys at the serialization boundary") so Rust-side platform code
and JS-side template code hash identically. The validator must print the
hash on success; the factory records the same hash in its attestation
ledger (statecraft spec 008), which is what makes the repo-local cert
independently checkable against the platform's record.

## 5. template.toml [provenance] (contract 0.3.0)

```toml
[provenance]
cert_path = ".statecraft/born-with.json"
cert_schema = ".statecraft/born-with.schema.json"
verify = "node scripts/verify-born-with.mjs"
postures = ["none", "assisted", "autonomous"]
```

Adding the table is a minor contract bump (0.2.0 -> 0.3.0) per spec 009
§3.1. (0.2.0 was already taken by spec 018's `[requires].toolchain`
key, which landed after this spec was drafted; the provenance table is
the next minor. The following contract minor, 0.4.0, belongs to the
scaffold verb of spec 014.) The `verify` verb in `[verbs]` is unchanged;
cert validation is a provenance concern the factory invokes separately,
because the verify verb must also pass in the template repo itself,
which has no cert.

## 6. Acceptance

- Schema rejects: missing posture, `defaulted: true`, unknown posture,
  short commit; accepts a well-formed cert.
- Validator round-trip: a fixture cert under `scripts/fixtures/` (or a
  temp file in tests) validates and prints a stable sha256 that matches
  an independently computed keysorted-JSON hash in the test.
- `spec-spine lint --fail-on-warn`, `index check`, typecheck, and vitest
  stay green; contract version reads 0.3.0.

## 7. Out of scope

- Emission (factory-side, statecraft spec 005) and ledger recording
  (statecraft spec 008).
- Ed25519 signing of certs: v1 certs are hash-anchored via the platform
  ledger, not self-signed. Signing is reserved for certVersion 2, whose
  designed path is the vended pair from the statecraft-ing lineage (OAP
  specs 219/220): the factory emits through tenant-emit with a
  platform-minted Ed25519 key delivered as a repo CI secret at repo
  creation (the mint belongs to statecraft specs 004/005), the stamped
  repo pins tenant-tail and re-verifies the certificate in its verify
  workflow, and the platform ledger anchor (statecraft spec 008) plays
  the countersign role. v1 keeps a bespoke validator precisely because
  tenant-tail verifies the signed governance-certificate shape, not
  this unsigned v1 cert; pinning tenant-tail before certVersion 2
  would verify nothing.
- Posture enforcement semantics (platform policy, not template).
