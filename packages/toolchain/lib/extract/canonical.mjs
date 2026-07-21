/**
 * Canonical serialization and hashing for the app model (spec 020 §3.5,
 * spec 021 §3.2). Mirrors canonical-keysort-json::to_canonical_string:
 * recursive lexicographic key sort, compact separators, UTF-8, single
 * trailing newline. The genesisPayload oracle in the seal step re-verifies
 * byte agreement against the Rust kernel on every extraction, so any
 * divergence here fails the build instead of shipping.
 *
 * The model bans non-integer numbers outright: serde_json and JSON.stringify
 * disagree on integral floats ("1.0" vs "1"), so integers are the only
 * numbers with a byte-stable cross-language serialization.
 */
import { createHash } from "node:crypto";

function sortValue(value, path) {
  if (Array.isArray(value)) {
    return value.map((v, i) => sortValue(v, `${path}[${i}]`));
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortValue(value[key], `${path}.${key}`);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isInteger(value)) {
    throw new Error(`non-integer number at ${path}: the model permits integers only`);
  }
  return value;
}

/** Compact canonical JSON string (no trailing newline). */
export function canonicalStringify(value) {
  return JSON.stringify(sortValue(value, "$"));
}

/** The canonical bytes of a document: canonical string + "\n". */
export function canonicalBytes(value) {
  return Buffer.from(`${canonicalStringify(value)}\n`, "utf8");
}

export function sha256Prefixed(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The model hash: canonical bytes of the document with `integrity` removed. */
export function computeIntegrityHash(doc) {
  const { integrity: _dropped, ...rest } = doc;
  return sha256Prefixed(canonicalBytes(rest));
}

/** Pretty file form: recursively key-sorted, 2-space indent, trailing newline. */
export function prettyStringify(value) {
  return `${JSON.stringify(sortValue(value, "$"), null, 2)}\n`;
}
