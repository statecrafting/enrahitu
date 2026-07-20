/**
 * Lower encore meta + the capability manifest into the app-model document
 * (spec 020 §3.2, spec 021 §3.2). Services and endpoints come from meta;
 * the declared ceiling (capabilities, resources, trust, gate, ledger,
 * observability, auth) comes from app-manifest.json. Every array is
 * emitted sorted per the schema's x-sortKey annotations; every number is
 * an integer. The document leaves here unsealed: gate.configHash and
 * integrity are pinned by the seal step.
 */
import { accessString, pathString } from "./meta.mjs";

// The contract's method vocabulary (spec 020). The parser expands a "*"
// method to its own wider set (TRACE included); the model records the
// intersection with the contract vocabulary.
const ALL_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];

function byKey(key) {
  return (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
}

function lowerEndpoint(rpc) {
  const methods =
    rpc.httpMethods.includes("*") || rpc.httpMethods.length === 0
      ? ALL_METHODS
      : [...new Set(rpc.httpMethods.filter((m) => ALL_METHODS.includes(m)))].sort();
  const endpoint = {
    name: rpc.name,
    path: pathString(rpc.path),
    methods,
    access: accessString(rpc),
  };
  if (rpc.proto === "RAW") endpoint.raw = true;
  if (rpc.streamingRequest) endpoint.streamingRequest = true;
  if (rpc.streamingResponse) endpoint.streamingResponse = true;
  return endpoint;
}

function sortedConstraints(constraints) {
  if (!constraints) return undefined;
  const out = { ...constraints };
  for (const key of ["tables", "domains", "topics", "tools"]) {
    if (Array.isArray(out[key])) out[key] = [...out[key]].sort();
  }
  return out;
}

/**
 * @param {object} args
 * @param {object} args.meta decoded encore.parser.meta.v1.Data
 * @param {object} args.manifest parsed app-manifest.json
 * @param {{revision: string, uncommittedChanges: boolean}} args.source
 * @param {string} args.producerVersion the toolchain package version
 */
export function lowerModel({ meta, manifest, source, producerVersion }) {
  const services = [...meta.svcs]
    .sort(byKey("name"))
    .map((svc) => {
      const declared = manifest.services?.[svc.name];
      return {
        name: svc.name,
        tier: declared?.tier ?? "ts",
        capabilities: [...(declared?.capabilities ?? [])].sort(),
        endpoints: svc.rpcs.map(lowerEndpoint).sort(byKey("name")),
      };
    });

  const capabilities = [...(manifest.capabilities ?? [])]
    .sort(byKey("id"))
    .map((cap) => {
      const out = { id: cap.id, kind: cap.kind, resource: cap.resource };
      const constraints = sortedConstraints(cap.constraints);
      if (constraints) out.constraints = constraints;
      return out;
    });

  const declaredResources = manifest.resources ?? {};
  const resources = {};
  for (const family of [
    "databases",
    "kv",
    "counters",
    "topics",
    "subscriptions",
    "buckets",
    "secrets",
    "crons",
  ]) {
    const entries = declaredResources[family];
    if (!entries) continue;
    resources[family] = [...entries].sort(byKey(family === "crons" ? "id" : "name"));
  }

  const agents = [...(manifest.agents ?? [])].sort(byKey("name")).map((agent) => ({
    ...agent,
    capabilities: [...(agent.capabilities ?? [])].sort(),
  }));

  const model = {
    contract: { name: "app-model", version: "0.1.0" },
    app: manifest.app,
    source: {
      revision: source.revision,
      uncommittedChanges: source.uncommittedChanges,
    },
    extraction: {
      producers: [{ tool: "enrahitu-extract", version: producerVersion, tier: "ts" }],
      verified: true,
    },
    types: [],
    resources,
    capabilities,
    services,
    agents,
    trust: manifest.trust ?? {
      levels: ["full", "restricted", "read-only", "suspended"],
    },
    gate: {
      checks: [...(manifest.gate?.checks ?? [])].sort(),
      configHash: "unpinned",
    },
    ledger: manifest.ledger,
    observability: manifest.observability,
    integrity: { algorithm: "sha256-canonical-keysort-v1", hash: "unsealed" },
  };
  if (manifest.auth) model.auth = manifest.auth;
  return model;
}
