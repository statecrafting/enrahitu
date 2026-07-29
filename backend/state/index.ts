/**
 * The state layer (spec 032): the typed, governed facade over hiqlite's
 * replicated SQL, watch, lease, and durability surfaces.
 *
 * Application code calls this. It never imports `@statecrafting/hiqlite-native`
 * directly, and the extraction ban-list enforces that (spec 002 §6, spec 021
 * §3.5): the addon is imported in exactly one place, `backend/hiq/init.ts`, and
 * reached from exactly two, this directory and `backend/kernel/hiq.ts`.
 *
 * ## Why two facades over one addon
 *
 * `backend/kernel/hiq.ts` (spec 021) governs the CACHE raft group: KV with TTL
 * and replicated counters, which is what the rate limiter needs. This directory
 * governs the SQLITE group, which is durable and is the state layer proper. The
 * split follows the raft groups rather than the file layout, and the groups have
 * genuinely different guarantees: cache state does not survive a full cluster
 * restart, which is correct for leases and rate-limit windows and disqualifying
 * for anything else. Merging them into one module would put two durability
 * contracts behind one import and invite exactly the confusion the split
 * prevents.
 *
 * ## What holds these grants
 *
 * Nothing yet, beyond schema ownership. The capabilities are declared in
 * `app-manifest.json` and the `state` service holds the migration ones; the
 * write, lease, watch, and backup grants are declared and granted to no service
 * until phase 3's control plane exists to hold them. Deny-by-default means an
 * ungranted capability is not a latent hole: a caller reaching for it today gets
 * a typed permission denial and a Decision record, which is the correct answer
 * for a consumer that has not been designed.
 */
export {
  query,
  queryConsistent,
  execute,
  executeReturning,
  txn,
} from "./sql";

export { notify, listen, listenerCount, type NotifyHandler } from "./watch";

export { lock, withLease, type Lease } from "./lease";

export { backup, backupListLocal, backupListS3 } from "./backup";

export {
  migrate,
  schemaVersion,
  MIGRATIONS_TABLE,
  type Migration,
  type AppliedMigration,
} from "./migrate";

export {
  SQL_RESOURCE,
  BACKUP_RESOURCE,
  COORD_RESOURCE,
  type BackupListing,
  type NotifyEnvelope,
  type SqlOptions,
  type SqlRow,
  type SqlStatement,
  type SqlValue,
  type Unsubscribe,
} from "./types";

/** Resolves once the embedded hiqlite node has completed its raft election. */
export { ready } from "../hiq/init";
