/**
 * Decode .encore/build/meta (raw protobuf, encore.parser.meta.v1.Data)
 * using the proto files this package carries (copied verbatim from
 * vendor/encore/proto at the pinned upstream version; MPL-2.0 at file
 * level, spec 008). The vendored tsparser is not patched: the toolchain
 * consumes its output artifact, exactly like the runtime does.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import protobuf from "protobufjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const protoRoot = join(packageRoot, "proto");

let cachedType;

async function metaType() {
  if (cachedType) return cachedType;
  const root = new protobuf.Root();
  // Resolve `import "encore/parser/..."` statements against our proto dir.
  root.resolvePath = (_origin, target) =>
    target.startsWith("/") ? target : join(protoRoot, target);
  await root.load(join(protoRoot, "encore/parser/meta/v1/meta.proto"));
  cachedType = root.lookupType("encore.parser.meta.v1.Data");
  return cachedType;
}

/**
 * Decode the meta file into a plain object with string enums and defaults
 * materialized (so absent repeated fields come back as [] and absent
 * scalars as their zero values).
 */
export async function decodeMeta(metaPath) {
  const type = await metaType();
  const message = type.decode(readFileSync(metaPath));
  return type.toObject(message, {
    enums: String,
    longs: Number,
    defaults: true,
    arrays: true,
    objects: true,
  });
}

/** Reconstruct the encore path string ("/auth/*rest") from Path segments. */
export function pathString(path) {
  const segments = path?.segments ?? [];
  const parts = segments.map((seg) => {
    switch (seg.type) {
      case "PARAM":
        return `:${seg.value}`;
      case "WILDCARD":
        return `*${seg.value}`;
      case "FALLBACK":
        return `!${seg.value}`;
      default:
        return seg.value;
    }
  });
  return `/${parts.join("/")}`;
}

const ACCESS = { PRIVATE: "private", PUBLIC: "public", AUTH: "auth" };

/** Map an RPC's access enum to the model vocabulary. */
export function accessString(rpc) {
  return ACCESS[rpc.accessType] ?? "private";
}
