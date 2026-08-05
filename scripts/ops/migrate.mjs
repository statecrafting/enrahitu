#!/usr/bin/env node
/**
 * `migrate`: one verb over both stores (spec 027 §3.4).
 *
 *   node scripts/ops/migrate.mjs            # report what is pending
 *   node scripts/ops/migrate.mjs --apply    # apply it
 *
 * It is a deploy step and not a boot step, for two reasons and the second is the
 * one that decides it: boot-time migration ties schema change to process restart,
 * so a crash loop becomes a migration loop; and once a topology runs more than
 * one app container against one ledger (spec 030), boot-time migration races.
 * The runner survives that race by construction, but surviving a race is not a
 * reason to run one.
 *
 * ## Why this is a client and not a runner
 *
 * The 2026-07-30 amendment put the state layer's half on the admin plane because
 * at N=1 the app holds the volume open. The 2026-08-04 settlement put
 * CoreLedger's half there too, for a reason that is not about the volume: the
 * runner and both drivers are TypeScript whose value imports the bundler
 * resolves and plain node does not, and the verbs run in the packaged image with
 * production dependencies and no transpiler. A script-shaped half would
 * therefore have to carry a SECOND runner, for a property whose entire value is
 * that there is one.
 *
 * So this verb owns no migration logic at all. It is the transport §3.4 asked
 * for: "one verb over both stores" is one verb over one plane, and each store's
 * pair does its own applying, adjudicated, with a principal's name on the
 * Decision it produces.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { adminRequest } from "./admin-plane.mjs";

/** The two stores, each with the pair the admin plane exposes for it. */
export const STORES = [
  {
    key: "state",
    label: "the state layer",
    read: "/api/admin/schema",
    apply: "/api/admin/schema/apply",
  },
  {
    key: "ledger",
    label: "CoreLedger",
    read: "/api/admin/ledger/schema",
    apply: "/api/admin/ledger/schema/apply",
  },
];

/** What each store reports as pending, without changing anything. */
export async function plan(env = process.env, opts = {}) {
  const stores = [];
  for (const store of STORES) {
    const body = await adminRequest(env, store.read, opts);
    stores.push({
      ...store,
      version: body.version,
      pending: body.pending ?? [],
    });
  }
  return stores;
}

/**
 * Apply what is pending, in both stores.
 *
 * Applying nothing is a result and not a no-op worth hiding: an operator running
 * this after a deploy that carried no migration should be told the schema is
 * current, in the same words as one that applied four.
 */
export async function apply(env = process.env, opts = {}) {
  const results = [];
  for (const store of STORES) {
    const body = await adminRequest(env, store.apply, { ...opts, method: "POST" });
    const applied = Array.isArray(body.applied) ? body.applied : [];
    results.push({
      ...store,
      version: body.version,
      applied: applied.map((entry) => (typeof entry === "number" ? entry : entry.version)),
      concurrent: body.concurrent,
    });
  }
  return results;
}

const invokedDirectly =
  import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;

if (invokedDirectly) {
  const shouldApply = process.argv.slice(2).includes("--apply");
  try {
    if (!shouldApply) {
      for (const store of await plan()) {
        if (store.pending.length === 0) {
          console.log(`[migrate] ${store.label}: at version ${store.version}, nothing pending`);
        } else {
          console.log(
            `[migrate] ${store.label}: at version ${store.version}, ${store.pending.length} ` +
              `pending: ${store.pending.map((m) => `${m.version} ${m.name}`).join(", ")}`,
          );
        }
      }
      console.log("[migrate] nothing was applied; re-run with --apply");
    } else {
      for (const store of await apply()) {
        if (store.applied.length === 0) {
          console.log(`[migrate] ${store.label}: already at version ${store.version}, applied nothing`);
        } else {
          console.log(
            `[migrate] ${store.label}: applied ${store.applied.join(", ")}, now at version ${store.version}`,
          );
        }
        if (store.concurrent) {
          console.log(`[migrate] ${store.label}: ${store.concurrent}`);
        }
      }
    }
  } catch (err) {
    console.error(`[migrate] refusing: ${err.message}`);
    process.exit(1);
  }
}
