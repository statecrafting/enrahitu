/**
 * The hot backup path's reach into the state layer (spec 027 §3.2).
 *
 * At N=1 the app's embedded hiqlite node holds the volume open, so nothing
 * outside the app can reach the store. That is the same constraint that put the
 * schema verb on this plane, and §3.4's 2026-08-04 settlement states the
 * generalization once rather than re-deriving it per verb: an operation on a
 * store the running app holds is performed BY the running app, under an
 * authenticated operator, and lands on the Decision chain naming a principal.
 *
 * So the `backup` verb's hot mode does not copy `/data/hiqlite`. It calls this
 * pair: create, then collect the named file off the volume. A cold backup needs
 * neither endpoint, because a stopped node's directory is exactly the state it
 * would recover from (§3.2).
 *
 * The `admin` service holds `cap.backup.state.write` and `cap.backup.state.list`
 * in the manifest, which were declared by spec 032 and held by no service until
 * now. It calls under its own attribution rather than borrowing the `state`
 * service's identity: a capability exercised under a name the manifest does not
 * grant is a ceiling that lies.
 */
import { api } from "encore.dev/api";

import { backup, backupListLocal, type BackupListing } from "../state";

import { requireOperator } from "./gate";

export interface StateBackupResponse {
  /** The file the verb collects, or null when the node reported no snapshot. */
  name: string | null;
  /** Epoch seconds, as the addon reports them. */
  lastModified: number | null;
  size?: number;
  /**
   * False when the addon's sixty-second duplicate-request guard answered with a
   * snapshot that already existed (spec 027 §3.1).
   *
   * The verb needs this to report honestly. A backup taken twice inside the
   * window is one snapshot, and an archive built from the second call carries a
   * member up to a minute older than the moment it was asked for. Saying so is
   * the difference between a stated RPO and an assumed one (§3.6).
   */
  fresh: boolean;
}

export interface StateBackupListResponse {
  backups: BackupListing[];
}

/** The newest entry by modification time, or null when there are none. */
function newest(listing: BackupListing[]): BackupListing | null {
  return listing.reduce<BackupListing | null>(
    (best, entry) => (best === null || entry.lastModified > best.lastModified ? entry : best),
    null,
  );
}

/**
 * Take a snapshot of the SQLite group and name the file it produced.
 *
 * `backup()` returns void, so the name is read back from the listing rather
 * than reported by the call. Reading the newest entry BEFORE as well as after
 * is what makes `fresh` answerable: the addon's duplicate guard is silent, and
 * a verb that cannot tell a new snapshot from a suppressed one cannot report
 * the age of what it is shipping.
 */
export const createStateBackup = api(
  { expose: true, auth: true, method: "POST", path: "/api/admin/state/backups" },
  async (): Promise<StateBackupResponse> => {
    requireOperator();
    const before = newest(await backupListLocal());
    await backup();
    const after = newest(await backupListLocal());
    if (after === null) {
      return { name: null, lastModified: null, fresh: false };
    }
    return {
      name: after.name,
      lastModified: after.lastModified,
      size: after.size,
      fresh: before === null || after.name !== before.name,
    };
  },
);

/**
 * The snapshots on this node's volume.
 *
 * The verb reads this when it cannot create one, which is §3.6's "falls back to
 * the most recent snapshot the addon already wrote, and its age is reported the
 * same way". It is never omitted and never silently stale.
 */
export const listStateBackups = api(
  { expose: true, auth: true, method: "GET", path: "/api/admin/state/backups" },
  async (): Promise<StateBackupListResponse> => {
    requireOperator();
    return { backups: await backupListLocal() };
  },
);
