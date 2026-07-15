/**
 * Ledger boot for the auth domain: create tables at service load so the first
 * request pays no DDL cost. Every model function awaits `dbReady` before
 * touching a repo.
 */
import { ledger } from "../core/ledger";

import { AuditLog, RefreshToken, UserAccount } from "./entities";

export const dbReady: Promise<void> = ledger().init([UserAccount, RefreshToken, AuditLog]);

// Prevent a process-level unhandledRejection if init fails before the first
// awaiter; the failure still surfaces on every `await dbReady`.
dbReady.catch(() => {});

export { ledger };
