/**
 * CoreLedger's declared migrations, in the one place that declares them
 * (spec 027 §3.4).
 *
 * `migrate()` (see `./migrations`) has been a correct forward-only runner with
 * no list to run since spec 011 landed it: `ensureSchema()` creates what is
 * missing at boot and cannot evolve a column, so a deployment carried a
 * migration mechanism and no migrations. This is the list, and the `migrate`
 * verb is the moment it runs.
 *
 * **This is chassis schema, not application schema.** An extension adds a kind
 * through the control plane's registry and needs no migration at all (spec 034,
 * and `app/README.md` says so in those words), which is why this file lives
 * under `backend/` where an upgrade replaces it wholesale rather than under
 * `app/` where an upgrade never touches it (spec 035). What belongs here is the
 * evolution of the tables the chassis itself owns.
 *
 * **Module-level imports must stay type-only.** `scripts/ops/preflight.mjs`
 * reports the pending count before the app is a process, so it loads this file
 * by path under Node's own type stripping: an `import type` is erased and costs
 * nothing, while a value import to an extensionless specifier is unresolvable
 * outside the bundler and would take the pre-flight report down with it.
 * `scripts/ops/preflight.test.ts` holds that line. It constrains this file and
 * nothing else: an `up()` body runs inside the app and may use what it needs, and
 * `up` receives the dialect precisely so a migration can branch on it without
 * reaching for a helper.
 */
import type { Migration } from "./migrations";

export const CORE_LEDGER_MIGRATIONS: Migration[] = [];
