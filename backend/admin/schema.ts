/**
 * The schema verb (spec 023 amendment 2026-07-30, spec 027 §3.4's state-layer
 * half).
 *
 * Spec 032 §3.6 settled that migration is a deploy step with one runner and not
 * a boot step. The complication this endpoint answers is where the store is: at
 * N=1 the app's embedded hiqlite node holds the volume open, so no second
 * process can reach it while the app runs. The deploy step therefore has to be
 * performed BY the running app, and the operator plane is where an operator's
 * act belongs: authenticated, role-gated, and adjudicated, so the migration
 * lands on the Decision chain naming a principal rather than happening
 * anonymously on somebody's shell.
 *
 * The `admin` service holds `cap.db.state.migrate` in the manifest and calls the
 * runner under its own attribution. It does not borrow the `state` service's
 * identity through `runAsService`: a capability exercised under a name the
 * manifest does not grant is a ceiling that lies, and a readable ceiling is the
 * whole point of spec 021.
 */
import { api } from "encore.dev/api";

import { CONTROL_PLANE_MIGRATIONS } from "../control/schema";
import { migrate, schemaVersion } from "../state";

import { requireOperator } from "./gate";
import { pendingMigrations, type MigrationSummary } from "./schema-plan";

export interface SchemaResponse {
  /** The highest applied version, or 0 when nothing has been applied. */
  version: number;
  pending: MigrationSummary[];
}

export interface AppliedResponse {
  version: number;
  applied: MigrationSummary[];
}

export const schema = api(
  { expose: true, auth: true, method: "GET", path: "/api/admin/schema" },
  async (): Promise<SchemaResponse> => {
    requireOperator();
    const version = await schemaVersion();
    return { version, pending: pendingMigrations(version, CONTROL_PLANE_MIGRATIONS) };
  },
);

/**
 * Apply what is pending. Idempotent: applying twice applies nothing the second
 * time and says so, rather than reporting a constraint violation (spec 027 §4
 * item 7 is the same property, asked of the other store).
 */
export const applySchema = api(
  { expose: true, auth: true, method: "POST", path: "/api/admin/schema/apply" },
  async (): Promise<AppliedResponse> => {
    requireOperator();
    const applied = await migrate(CONTROL_PLANE_MIGRATIONS);
    return { version: await schemaVersion(), applied };
  },
);
