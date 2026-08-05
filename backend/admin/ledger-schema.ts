/**
 * CoreLedger's half of the `migrate` verb (spec 027 §3.4).
 *
 * The state layer's half landed on this plane on 2026-07-30 because at N=1 the
 * app's embedded hiqlite node holds the volume open, so no second process can
 * reach the store. CoreLedger is not held that way: a libSQL file admits other
 * processes and a Postgres ledger is remote by definition, so the volume
 * argument does not carry, and §3.4 kept this half script-shaped on the
 * strength of that.
 *
 * It lands here anyway, for two reasons the volume argument never covered:
 *
 * 1. **A script cannot run the runner.** `migrate()` and both drivers are TS
 *    whose value imports the bundler resolves and plain node does not, and the
 *    verbs run in the packaged image with production dependencies and no
 *    transpiler. A script-shaped half would therefore be a SECOND runner, for a
 *    property whose entire value is that there is one. That is the same
 *    duplication spec 027 §3.5 just removed from the entrypoint.
 * 2. **A migration is an act, and an act has an actor.** Through this plane it
 *    is authenticated, role-gated, and adjudicated, so it lands on the Decision
 *    chain naming a principal instead of happening anonymously on somebody's
 *    shell.
 *
 * So "one verb over both stores" (§3.4's 2026-07-30 amendment) is one verb over
 * one transport, and the pattern §3.4's 2026-08-04 settlement states once now
 * covers both halves rather than being re-derived per store.
 *
 * The `admin` service holds `cap.db.app.migrate` and `cap.db.app.read` in the
 * manifest, mirroring exactly what it holds for the state layer. It does not
 * borrow `auth`'s identity through `runAsService`: a capability exercised under
 * a name the manifest does not grant is a ceiling that lies.
 */
import { api } from "encore.dev/api";

import { CORE_LEDGER_MIGRATIONS, ledger } from "../core/ledger";

import { requireOperator } from "./gate";
import { pendingMigrations, type MigrationSummary } from "./schema-plan";

export interface LedgerSchemaResponse {
  /** The highest applied version, or 0 when nothing has been applied. */
  version: number;
  pending: MigrationSummary[];
}

export interface LedgerAppliedResponse {
  version: number;
  applied: number[];
  /**
   * Present only when another runner recorded a version mid-flight. The ledger
   * is consistent and nothing is half-applied; running again continues.
   */
  concurrent?: string;
}

export const ledgerSchema = api(
  { expose: true, auth: true, method: "GET", path: "/api/admin/ledger/schema" },
  async (): Promise<LedgerSchemaResponse> => {
    requireOperator();
    const version = await ledger().schemaVersion();
    return { version, pending: pendingMigrations(version, CORE_LEDGER_MIGRATIONS) };
  },
);

/**
 * Apply what is pending. Idempotent: applying twice applies nothing the second
 * time and says so, which is spec 027 §4 item 7 asked of this store.
 */
export const applyLedgerSchema = api(
  { expose: true, auth: true, method: "POST", path: "/api/admin/ledger/schema/apply" },
  async (): Promise<LedgerAppliedResponse> => {
    requireOperator();
    const result = await ledger().migrate(CORE_LEDGER_MIGRATIONS);
    return { version: result.version, applied: result.applied, concurrent: result.concurrent };
  },
);
