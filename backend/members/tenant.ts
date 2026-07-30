/**
 * The tenant seam (spec 036 §3.2).
 *
 * A tenant is the association (spec 001 §5.3, as amended). One deployment serves
 * one, so this returns one value, and the value is an operator-chosen slug read
 * from `ENRAHITU_TENANT`: required in production, `local-dev` outside it, and
 * never generated.
 *
 * **Why not a generated identifier**, which is where the first draft of this
 * went. An opaque `org-<hex>` minted at first boot is a sentinel with more
 * entropy. It makes the value that seeds every primary key machine-specific, so
 * fixtures and cross-environment comparison stop lining up. It puts the identity
 * that determines every key in a text file with no admission record, so losing
 * the volume silently mints a new one and orphans every row that survived. And
 * opacity buys nothing here, because fleet-hosting produces separate apps rather
 * than tenants inside one, so there is nothing to collide with.
 *
 * This does not make the app multi-tenant ready and should not be read as if it
 * does. It has only ever returned one value, so it is untested for the case it
 * exists to serve, and the expensive part of multi-tenancy is isolation
 * correctness rather than key shape. What it buys is narrow: no permanent
 * translation rule in the audit story later, for a cost of approximately zero
 * now, because `admit` demands a tenant from a tenant-scoped kind and every call
 * site passes one either way.
 *
 * The principal-to-tenant binding spec 001 §5.3 describes lands here when spec
 * 004's rewrite gives a session its tenant. Today every authenticated principal
 * belongs to the deployment's one association.
 */
import { env } from "../lib/env";
import { query } from "../state";

const DEV_TENANT = "local-dev";

// Deliberately narrow: this string goes into a primary key, a URL, and every
// Decision reason string, so it is bounded, lowercase, and free of anything that
// needs escaping downstream.
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * The one failure that must stop the process rather than degrade.
 *
 * Its own type because the boot path has to tell it apart from every other way
 * starting can fail. A store that is briefly unreachable should leave the app
 * serving `/healthz`, the admin dashboard, and a 503 on this domain, because
 * those are exactly what an operator needs when the store is broken. Writing a
 * second dataset is different in kind: it is silent, it compounds, and staying
 * up makes it worse.
 */
export class TenantMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantMismatchError";
  }
}

let resolved: string | undefined;

/** The deployment's association. Throws in production when unconfigured. */
export function tenantId(): string {
  if (resolved !== undefined) return resolved;
  const configured = process.env.ENRAHITU_TENANT?.trim();

  if (!configured) {
    if (env.isProduction) {
      throw new Error(
        "ENRAHITU_TENANT is required: it names the association this deployment serves and " +
          "seeds every resource key. Set it at provisioning to a stable slug and never change it.",
      );
    }
    resolved = DEV_TENANT;
    return resolved;
  }

  if (!SLUG.test(configured)) {
    throw new Error(
      `ENRAHITU_TENANT '${configured}' is not a valid slug: lowercase letters, digits and hyphens, ` +
        "2 to 63 characters, starting with a letter or digit.",
    );
  }
  resolved = configured;
  return resolved;
}

/** Test seam: drop the memoized value so a test can vary the environment. */
export function resetTenantForTest(): void {
  resolved = undefined;
}

/**
 * Refuse to start against a dataset written under a different tenant.
 *
 * This matters more than the choice of identifier. The tenant determines every
 * primary key, so if the resolved value and the stored value disagree, the
 * deployment writes a second, invisible dataset alongside the first: members
 * that exist and cannot be found, dues raised against rows nobody reads. It is
 * silent, it compounds daily, and by the time anyone notices, both halves have
 * real data in them.
 *
 * Three things cause it and all three are ordinary: an edited environment
 * variable, a lost or swapped volume, and a config file copied between
 * deployments. The check costs one read of one column.
 *
 * Cluster-scoped rows (tenant `''`) are excluded rather than compared: they
 * belong to no association by construction (spec 034 §3.2).
 */
export async function assertTenantConsistency(): Promise<void> {
  const mine = tenantId();
  const rows = await query<{ tenant: string }>(
    `SELECT DISTINCT tenant FROM resource WHERE tenant <> '' ORDER BY tenant LIMIT 5`,
    [],
    { tables: ["resource"] },
  );
  const foreign = rows.map((r) => String(r.tenant)).filter((t) => t !== mine);
  if (foreign.length === 0) return;

  throw new TenantMismatchError(
    `refusing to start: this deployment resolves ENRAHITU_TENANT to '${mine}', but its store ` +
      `already holds rows for ${foreign.map((t) => `'${t}'`).join(", ")}. Serving would write a ` +
      "second dataset alongside the existing one. Restore the previous value, or point this " +
      "deployment at its own volume.",
  );
}
