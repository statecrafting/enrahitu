/**
 * Ledger boot for the auth domain: create tables at service load so the first
 * request pays no DDL cost. Every model function awaits `dbReady` before
 * touching a repo.
 */
import { ledger } from "../core/ledger";
import { runAsService } from "../kernel/adjudicate";
import { ensureDecisionLedger } from "../kernel/decisions";

import { AuditLog, RefreshToken, UserAccount } from "./entities";

// Module-eval DDL runs under explicit kernel attribution (spec 021 §3.5:
// no request context exists yet, and unattributable is denied). Once the
// schema is up, the deploy genesis lands in the Decision ledger.
export const dbReady: Promise<void> = runAsService("auth", () =>
  ledger().init([UserAccount, RefreshToken, AuditLog]),
).then(() => ensureDecisionLedger());

// Prevent a process-level unhandledRejection if init fails before the first
// awaiter; the failure still surfaces on every `await dbReady`.
dbReady.catch(() => {});

export { ledger };
