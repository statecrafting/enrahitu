#!/usr/bin/env node
// Validator for the born-with provenance certificate (spec 012).
//
//   node scripts/verify-born-with.mjs [path]   # default .statecraft/born-with.json
//
// Exit 0 and print the certificate's sha256 identity hash when the cert is
// valid; exit 1 and print the reasons when it is not. The schema
// (.statecraft/born-with.schema.json) is the single source of truth for shape:
// this file applies it, so "the schema rejects X" and "the validator rejects X"
// are the same statement. Dependency-free on purpose, so a stamped app can run
// it with nothing but node.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const SCHEMA_PATH = join(repoRoot, ".statecraft", "born-with.schema.json");
const DEFAULT_CERT_PATH = join(repoRoot, ".statecraft", "born-with.json");

// --- Canonical form and hash (spec 012 §4) --------------------------------
// Recursive lexicographic sort of object keys, then compact serialization:
// byte-identical to canonical-keysort-json's to_canonical_string for the fixed
// ASCII key set of this certificate, so JS-side and Rust-side code hash alike.
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
    return sorted;
  }
  return value;
}

export function canonicalString(value) {
  return JSON.stringify(canonicalize(value));
}

export function certHash(cert) {
  return createHash("sha256").update(canonicalString(cert), "utf8").digest("hex");
}

// --- Minimal draft 2020-12 evaluator --------------------------------------
// Supports exactly the constructs the born-with schema uses: type (object,
// string), const, enum, pattern, minLength, required, properties, and
// additionalProperties:false. Returns a list of human-readable reasons.
export function validate(instance, schema, path = "") {
  const errors = [];
  const loc = path || "(root)";

  if ("const" in schema && instance !== schema.const) {
    errors.push(`${loc}: must equal ${JSON.stringify(schema.const)}`);
  }
  if ("enum" in schema && !schema.enum.includes(instance)) {
    errors.push(`${loc}: must be one of ${JSON.stringify(schema.enum)}`);
  }

  if (schema.type === "object") {
    if (instance === null || typeof instance !== "object" || Array.isArray(instance)) {
      errors.push(`${loc}: must be an object`);
      return errors;
    }
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(instance, key)) {
        errors.push(`${loc}: missing required property "${key}"`);
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(instance)) {
        if (!allowed.has(key)) errors.push(`${loc}: unexpected property "${key}"`);
      }
    }
    for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(instance, key)) {
        errors.push(...validate(instance[key], subSchema, path ? `${path}.${key}` : key));
      }
    }
  } else if (schema.type === "string") {
    if (typeof instance !== "string") {
      errors.push(`${loc}: must be a string`);
    } else {
      if (schema.minLength !== undefined && instance.length < schema.minLength) {
        errors.push(`${loc}: must be at least ${schema.minLength} character(s)`);
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(instance)) {
        errors.push(`${loc}: must match /${schema.pattern}/`);
      }
    }
  }

  return errors;
}

export function loadSchema(schemaPath = SCHEMA_PATH) {
  return JSON.parse(readFileSync(schemaPath, "utf8"));
}

// --- CLI ------------------------------------------------------------------
function main(argv) {
  const certPath = argv[0] ? resolve(process.cwd(), argv[0]) : DEFAULT_CERT_PATH;

  let raw;
  try {
    raw = readFileSync(certPath, "utf8");
  } catch (err) {
    console.error(`x cannot read ${certPath}: ${err.message}`);
    return 1;
  }

  let cert;
  try {
    cert = JSON.parse(raw);
  } catch (err) {
    console.error(`x ${certPath}: invalid JSON: ${err.message}`);
    return 1;
  }

  const errors = validate(cert, loadSchema());
  if (errors.length > 0) {
    console.error(`x ${certPath} is not a valid born-with certificate:`);
    for (const reason of errors) console.error(`  - ${reason}`);
    return 1;
  }

  console.log(`ok ${certPath}`);
  console.log(`sha256 ${certHash(cert)}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
