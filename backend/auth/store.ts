/**
 * Ledger boot for the auth domain: create tables at service load so the first
 * request pays no DDL cost. Every model function awaits `dbReady` before
 * touching a repo.
 */
import { ledger } from "../core/ledger";
import { runAsService } from "../kernel/adjudicate";
import { ensureDecisionLedger } from "../kernel/decisions";

import { AuditLog } from "./entities";

// Module-eval DDL runs under explicit kernel attribution (spec 021 §3.5:
// no request context exists yet, and unattributable is denied). Once the
// schema is up, the deploy genesis lands in the Decision ledger.
//
// One entity, not three. `UserAccount` and `RefreshToken` retired with the
// 2026-08-03 rewrite (spec 001 §5.3): the app keeps no opinion about who a
// principal is and no record of which sessions are alive, because rauthy holds
// both. `AuditLog` stays, because what happened is application data and
// outlives whichever authority was asked at the time.
//
// The two tables are deliberately NOT dropped. A deployment upgrading through
// this change has rows in them, and they are the only record of who logged in
// before the cutover; dropping them at boot would destroy that to save two
// unused tables. They are left in place, unread, for an operator to remove.
export const dbReady: Promise<void> = runAsService("auth", () =>
  ledger().init([AuditLog]),
).then(() => ensureDecisionLedger());

// Prevent a process-level unhandledRejection if init fails before the first
// awaiter; the failure still surfaces on every `await dbReady`.
dbReady.catch(() => {});

export { ledger };
