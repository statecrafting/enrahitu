/**
 * Durable audit trail writer. Writes are best-effort and must never block or
 * fail the user flow: a write error is logged and swallowed. Unlike the log
 * stream (lib/logger.ts), the audit table intentionally records actor
 * identity, which is its purpose as a compliance artifact.
 */
import { AuditLog } from "../auth/entities";
import { dbReady, ledger } from "../auth/store";

import { logSecurityEvent } from "./logger";

export interface AuditEntry {
  action: string;
  tableName?: string;
  recordId?: string;
  oldData?: unknown;
  newData?: unknown;
  actorId?: string;
  actorEmail?: string;
  ipAddress?: string;
  userAgent?: string;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await dbReady;
    await ledger().repo(AuditLog).insert(
      Object.assign(new AuditLog(), {
        action: entry.action,
        tableName: entry.tableName ?? null,
        recordId: entry.recordId ?? null,
        oldData: entry.oldData ?? null,
        newData: entry.newData ?? null,
        actorId: entry.actorId ?? null,
        actorEmail: entry.actorEmail ?? null,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
      }),
    );
  } catch {
    logSecurityEvent("audit.write_failed", { action: entry.action });
  }
}
