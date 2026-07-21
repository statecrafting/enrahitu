/**
 * The verify step (spec 020 §3.6, spec 021 §3.2): a model is only emitted
 * if every check passes. Checks: schema-valid, arrays sorted per the
 * schema's x-sortKey annotations, cross-references resolve, the manifest's
 * service set equals meta's, observed usage subset-of declared, ban-list.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

import { banViolations, covered, observeService } from "./usage.mjs";

const require = createRequire(import.meta.url);

export class VerifyError extends Error {
  constructor(violations) {
    super(`app-model verification failed:\n  - ${violations.join("\n  - ")}`);
    this.violations = violations;
  }
}

function schemaViolations(model, repoRoot) {
  const Ajv2020 = require("ajv/dist/2020.js").default;
  const schema = JSON.parse(
    readFileSync(join(repoRoot, "contracts", "app-model.schema.json"), "utf8"),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (validate(model)) return [];
  return validate.errors.map((e) => `schema: ${e.instancePath || "/"} ${e.message}`);
}

/**
 * Sortedness per the schema's x-sortKey annotations, mirrored here as an
 * explicit path table ("." means the array element itself).
 */
const SORT_RULES = [
  ["extraction.producers", "tool"],
  ["types", "id"],
  ["resources.databases", "name"],
  ["resources.kv", "name"],
  ["resources.counters", "name"],
  ["resources.topics", "name"],
  ["resources.subscriptions", "name"],
  ["resources.buckets", "name"],
  ["resources.secrets", "name"],
  ["resources.crons", "id"],
  ["capabilities", "id"],
  ["capabilities[].constraints.tables", "."],
  ["capabilities[].constraints.domains", "."],
  ["capabilities[].constraints.topics", "."],
  ["capabilities[].constraints.tools", "."],
  ["services", "name"],
  ["services[].capabilities", "."],
  ["services[].endpoints", "name"],
  ["services[].endpoints[].methods", "."],
  ["services[].endpoints[].capabilities", "."],
  ["agents", "name"],
  ["agents[].capabilities", "."],
  ["gate.checks", "."],
];

function valuesAt(doc, path) {
  let current = [doc];
  for (const part of path.split(".")) {
    const next = [];
    for (const node of current) {
      if (part.endsWith("[]")) {
        const arr = node?.[part.slice(0, -2)];
        if (Array.isArray(arr)) next.push(...arr);
      } else if (node?.[part] !== undefined) {
        next.push(node[part]);
      }
    }
    current = next;
  }
  return current;
}

function sortViolations(model) {
  const out = [];
  for (const [path, key] of SORT_RULES) {
    for (const arr of valuesAt(model, path)) {
      if (!Array.isArray(arr)) continue;
      for (let i = 1; i < arr.length; i += 1) {
        const prev = key === "." ? arr[i - 1] : arr[i - 1]?.[key];
        const curr = key === "." ? arr[i] : arr[i]?.[key];
        if (String(prev) > String(curr)) {
          out.push(`unsorted array at ${path} (by ${key}): "${curr}" after "${prev}"`);
          break;
        }
      }
    }
  }
  return out;
}

/** Which resource family (if any) a capability kind's resource names. */
const KIND_FAMILY = {
  db: "databases",
  kv: "kv",
  counter: "counters",
  pubsub: "topics",
  bucket: "buckets",
  secret: "secrets",
};

function crossRefViolations(model) {
  const out = [];
  const capIds = new Set(model.capabilities.map((c) => c.id));
  const serviceNames = new Set(model.services.map((s) => s.name));
  for (const svc of model.services) {
    for (const ref of svc.capabilities) {
      if (!capIds.has(ref)) out.push(`service '${svc.name}' references unknown capability '${ref}'`);
    }
  }
  for (const agent of model.agents ?? []) {
    if (!serviceNames.has(agent.service)) {
      out.push(`agent '${agent.name}' references unknown service '${agent.service}'`);
    }
    for (const ref of agent.capabilities) {
      if (!capIds.has(ref)) out.push(`agent '${agent.name}' references unknown capability '${ref}'`);
    }
  }
  for (const cap of model.capabilities) {
    const family = KIND_FAMILY[cap.kind.split(".")[0]];
    if (!family || cap.resource === "*") continue;
    const names = new Set((model.resources[family] ?? []).map((r) => r.name));
    if (!names.has(cap.resource)) {
      out.push(
        `capability '${cap.id}' names resource '${cap.resource}' missing from resources.${family}`,
      );
    }
  }
  return out;
}

function serviceSetViolations(model, manifest, meta) {
  const out = [];
  const metaNames = new Set(meta.svcs.map((s) => s.name));
  const manifestNames = new Set(Object.keys(manifest.services ?? {}));
  for (const name of metaNames) {
    if (!manifestNames.has(name)) out.push(`service '${name}' exists in source but not in app-manifest.json`);
  }
  for (const name of manifestNames) {
    if (!metaNames.has(name)) out.push(`service '${name}' declared in app-manifest.json but not found in source`);
  }
  return out;
}

function secretsViolations(model, meta) {
  const declared = new Set((model.resources.secrets ?? []).map((s) => s.name));
  const out = [];
  for (const pkg of meta.pkgs ?? []) {
    for (const name of pkg.secrets ?? []) {
      // Model resource names are the lowercase form of the encore binding.
      if (!declared.has(name.toLowerCase())) {
        out.push(`secret '${name}' observed in ${pkg.relPath} but not declared in resources.secrets`);
      }
    }
  }
  return out;
}

function usageViolations(model, manifest, meta, repoRoot) {
  const out = [];
  const catalog = new Map(model.capabilities.map((c) => [c.id, c]));
  for (const svc of meta.svcs) {
    const declared = manifest.services?.[svc.name];
    if (!declared || declared.role === "library") continue;
    const grants = (declared.capabilities ?? [])
      .map((id) => catalog.get(id))
      .filter(Boolean);
    for (const touch of observeService(repoRoot, svc.relPath)) {
      if (!covered(touch, grants)) {
        const what = touch.family ?? `${touch.kind} on '${touch.resource}'`;
        out.push(
          `service '${svc.name}' uses ${what} (via ${touch.via}) beyond its declared ceiling`,
        );
      }
    }
    const pkgCalls = (meta.pkgs ?? []).filter(
      (p) => p.serviceName === svc.name && (p.rpcCalls ?? []).length > 0,
    );
    if (pkgCalls.length > 0 && !grants.some((g) => g.kind === "endpoint.call")) {
      out.push(`service '${svc.name}' makes service-to-service calls without an endpoint.call grant`);
    }
  }
  return out;
}

/** Throws VerifyError on any violation. */
export function verifyModel({ model, manifest, meta, repoRoot }) {
  const violations = [
    ...schemaViolations(model, repoRoot),
    ...sortViolations(model),
    ...crossRefViolations(model),
    ...serviceSetViolations(model, manifest, meta),
    ...secretsViolations(model, meta),
    ...usageViolations(model, manifest, meta, repoRoot),
    ...banViolations(repoRoot),
  ];
  if (violations.length > 0) throw new VerifyError(violations);
}
