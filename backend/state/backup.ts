/**
 * The governed durability surface (spec 032 §3.8).
 *
 * `backup()` covers the SQLITE group only. Counters, lock state, and cache KV
 * live in the cache group and do not survive a restore, which is the reason
 * nothing durable belongs there.
 *
 * **A boot precondition this facade cannot enforce but must name.** Enabling
 * the addon's `backup` feature pulls hiqlite's `s3` feature, which makes
 * `enc_keys` mandatory: the node refuses to start without encryption keys.
 * `ENRAHITU_HIQ_ENC_KEYS` takes the same format rauthy's `ENC_KEYS` uses, so a
 * deployment custodies one key set for both. A publicly-known development key
 * is the fallback and the addon warns loudly on every boot; a deployment that
 * ships with that warning in its logs is storing data under a key anyone can
 * read.
 *
 * ## Why these adjudicate as bucket capabilities
 *
 * The kernel's capability vocabulary is a fixed 28 kinds (spec 020 §3.3,
 * statecrafting `kinds.rs`) and boot refuses a model declaring one it does not
 * know, so `backup.create` is not available without a kernel release and a
 * contract amendment. It is not needed either: a backup genuinely IS an
 * object-store write of the database, and `bucket.write` names that effect
 * honestly and is classified non-read, so it fails closed at `read-only` trust.
 * Listing is `bucket.list`, which is read-classified for the same reason.
 *
 * If a later contract adds backup kinds, this is the only file that changes.
 */
import { demand } from "../kernel/adjudicate";

import hiqlite, { ready } from "../hiq/init";

import { BACKUP_RESOURCE } from "./types";
import type { BackupListing } from "./types";

/**
 * Create an on-demand backup of the SQLite state machine.
 *
 * The scheduled cron backup alone cannot bracket a risky operation, and
 * bracketing is the difference between an RPO equal to the cron interval and an
 * RPO of zero for the operations that actually threaten data: upgrades,
 * migrations, and bulk imports each take a backup immediately before.
 *
 * Safe to call while serving: hiqlite issues `VACUUM main INTO` on the writer
 * thread, so it is serialized against writes rather than racing them,
 * leader-only, with a sixty-second duplicate-request guard.
 */
export async function backup(): Promise<void> {
  demand("bucket.write", BACKUP_RESOURCE);
  await ready;
  return hiqlite.backup();
}

/** List the backups on this node's volume. */
export async function backupListLocal(): Promise<BackupListing[]> {
  demand("bucket.list", BACKUP_RESOURCE);
  await ready;
  return hiqlite.backupListLocal();
}

/**
 * List the backups in the configured S3 bucket.
 *
 * Errors rather than returning empty when no bucket is configured: an operator
 * asking what off-box copies exist must not be told "none" by a code path that
 * means "nowhere to look".
 */
export async function backupListS3(): Promise<BackupListing[]> {
  demand("bucket.list", BACKUP_RESOURCE);
  await ready;
  return hiqlite.backupListS3();
}
