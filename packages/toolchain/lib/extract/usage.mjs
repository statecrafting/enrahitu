/**
 * The observed-usage side of the verify step (spec 021 §3.2): a transitive
 * import walk from each non-library service directory over backend/,
 * mapping named imports of the governed facades to capability kinds, plus
 * the static ban-list of fork 3's honesty clause.
 *
 * Granularity is deliberately v0.1: exact kinds where the facade names
 * them (hiq facade functions, secret accessors), family level for
 * CoreLedger and egress. Per-verb and per-table static attribution is the
 * named v0.2 extension (spec 020 §3.4).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

/** Named-import maps for the governed facades, keyed by repo-relative target. */
const HIQ_FACADE = "backend/kernel/hiq.ts";
const SECRETS_MODULE = "backend/lib/secrets.ts";
const EGRESS_MODULE = "backend/kernel/egress.ts";

const HIQ_KINDS = {
  kvGet: { kind: "kv.get", resource: "cache" },
  kvPut: { kind: "kv.put", resource: "cache" },
  kvDel: { kind: "kv.delete", resource: "cache" },
  counterAdd: { kind: "counter.add", resource: "counters" },
  counterGet: { kind: "counter.get", resource: "counters" },
  counterSet: { kind: "counter.set", resource: "counters" },
  counterDel: { kind: "counter.delete", resource: "counters" },
};

// Model resource names are the lowercase form of the encore secret binding
// (the contract's slug pattern forbids uppercase; spec 021 §3.1).
const SECRET_ACCESSORS = {
  accessPrivateKey: "jwt_private_key",
  accessPublicKey: "jwt_public_key",
  refreshPrivateKey: "jwt_refresh_private_key",
  refreshPublicKey: "jwt_refresh_public_key",
  rauthyClientSecretValue: "rauthy_client_secret",
};

function listTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Parse one file's import/export-from edges: [{specifier, named: string[]}]. */
function importEdges(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    false,
  );
  const edges = [];
  for (const stmt of source.statements) {
    let specifier;
    const named = [];
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      specifier = stmt.moduleSpecifier.text;
      const bindings = stmt.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) named.push((el.propertyName ?? el.name).text);
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        // A namespace import is opaque to per-name attribution: observe it
        // conservatively as touching everything the target module maps.
        named.push("*");
      }
      if (stmt.importClause?.name) named.push("default");
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      specifier = stmt.moduleSpecifier.text;
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) named.push((el.propertyName ?? el.name).text);
      }
    }
    if (specifier) edges.push({ specifier, named });
  }
  return edges;
}

function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

function rel(repoRoot, file) {
  return relative(repoRoot, file).split(sep).join("/");
}

/**
 * Walk one service's reachable modules and collect faculty touches.
 * Traversal stops at faculty targets (the enforcement plane is not
 * app code) and never enters backend/kernel/ or backend/core/ledger/.
 */
export function observeService(repoRoot, serviceDir) {
  const touches = [];
  const seen = new Set();
  const queue = listTsFiles(join(repoRoot, serviceDir));
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const edge of importEdges(file)) {
      if (!edge.specifier.startsWith(".")) continue;
      const target = resolveRelative(file, edge.specifier);
      if (!target) continue;
      const targetRel = rel(repoRoot, target);
      if (!targetRel.startsWith("backend/")) continue;
      if (targetRel === HIQ_FACADE) {
        const names = edge.named.includes("*") ? Object.keys(HIQ_KINDS) : edge.named;
        for (const name of names) {
          if (HIQ_KINDS[name]) touches.push({ ...HIQ_KINDS[name], via: rel(repoRoot, file) });
        }
      } else if (targetRel === SECRETS_MODULE) {
        const names = edge.named.includes("*") ? Object.keys(SECRET_ACCESSORS) : edge.named;
        for (const name of names) {
          if (SECRET_ACCESSORS[name]) {
            touches.push({
              kind: "secret.read",
              resource: SECRET_ACCESSORS[name],
              via: rel(repoRoot, file),
            });
          }
        }
      } else if (targetRel === EGRESS_MODULE) {
        touches.push({ family: "http.egress", via: rel(repoRoot, file) });
      } else if (targetRel.startsWith("backend/core/ledger/")) {
        touches.push({ family: "db", via: rel(repoRoot, file) });
      } else if (targetRel.startsWith("backend/kernel/")) {
        // Other kernel modules (boot, adjudicate, decisions) are the
        // enforcement plane itself: not an app-tier faculty touch.
        continue;
      } else {
        queue.push(target);
      }
    }
  }
  return touches;
}

/** Is `touch` covered by one of `grants` (the service's declared ceiling)? */
export function covered(touch, grants) {
  if (touch.family === "db") return grants.some((g) => g.kind.startsWith("db."));
  if (touch.family === "http.egress") return grants.some((g) => g.kind === "http.egress");
  return grants.some(
    (g) => g.kind === touch.kind && (g.resource === "*" || g.resource === touch.resource),
  );
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const BANS = [
  {
    id: "raw-addon-import",
    allowed: new Set(["backend/hiq/init.ts"]),
    hit: (edges) => edges.some((e) => e.specifier === "@enrahitu/hiqlite-native"),
    message: "raw @enrahitu/hiqlite-native import outside backend/hiq/init.ts",
  },
  {
    id: "raw-hiq-init-import",
    allowed: new Set(["backend/kernel/hiq.ts"]),
    hit: (edges, file, repoRoot) =>
      edges.some((e) => {
        if (!e.specifier.startsWith(".")) return false;
        const target = resolveRelative(file, e.specifier);
        return target !== undefined && rel(repoRoot, target) === "backend/hiq/init.ts";
      }),
    message: "hiq/init import outside the governed facade backend/kernel/hiq.ts",
  },
  {
    id: "bare-fetch",
    allowed: new Set(["backend/kernel/egress.ts"]),
    hit: (_edges, file) => /(?<![.\w])fetch\s*\(/.test(stripComments(readFileSync(file, "utf8"))),
    message: "bare fetch() outside the governed egress facade backend/kernel/egress.ts",
  },
  {
    id: "raw-driver",
    allowed: undefined, // path-prefix rule, see below
    hit: (_edges, file) =>
      /\b(new\s+(LibsqlDriver|PostgresDriver)\s*\(|rawDriverFromEnv\s*\()/.test(
        stripComments(readFileSync(file, "utf8")),
      ),
    allowedPath: (relPath) =>
      relPath.startsWith("backend/core/ledger/") || relPath === "backend/kernel/decisions.ts",
    message:
      "raw driver construction outside backend/core/ledger/ and the Decision store",
  },
  {
    id: "raw-secret-binding",
    allowed: new Set(["backend/lib/secrets.ts"]),
    hit: (edges) => edges.some((e) => e.specifier === "encore.dev/config"),
    message: "encore.dev/config secret binding outside backend/lib/secrets.ts",
  },
];

/** Scan all backend runtime modules against the ban-list. */
export function banViolations(repoRoot) {
  const violations = [];
  for (const file of listTsFiles(join(repoRoot, "backend"))) {
    const relPath = rel(repoRoot, file);
    const edges = importEdges(file);
    for (const ban of BANS) {
      if (!ban.hit(edges, file, repoRoot)) continue;
      const ok = ban.allowedPath ? ban.allowedPath(relPath) : ban.allowed.has(relPath);
      if (!ok) violations.push(`${relPath}: ${ban.message}`);
    }
  }
  return violations;
}
