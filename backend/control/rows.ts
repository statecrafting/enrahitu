/**
 * The stored row shape and its hydration, shared by admission and the watch.
 *
 * Its own module so the two agree by construction. When admission owned the
 * hydration privately, the watch's only options were to import from the module
 * it is downstream of or to keep a second copy, and a second copy of "how a
 * stored resource becomes a value" is how a `spec` ends up parsed in one path
 * and left as a JSON string in the other.
 */
import type { Resource } from "./admission";

/** One `resource` row, exactly as the store returns it. */
export interface ResourceRow {
  kind: string;
  tenant: string;
  name: string;
  revision: number;
  fence: number;
  spec: string;
  status: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export function hydrateRow<TSpec>(row: ResourceRow): Resource<TSpec> {
  return {
    kind: row.kind,
    tenant: row.tenant,
    name: row.name,
    // hiqlite returns SQLite INTEGERs as JS numbers, but the coercion is kept
    // explicit: a column that ever widens to TEXT would otherwise produce a
    // Resource whose revision compares as a string, and `"10" > "9"` is false.
    revision: Number(row.revision),
    fence: Number(row.fence),
    spec: JSON.parse(row.spec) as TSpec,
    status: row.status === null ? null : (JSON.parse(row.status) as unknown),
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
