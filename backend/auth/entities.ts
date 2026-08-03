/**
 * Auth-domain CoreLedger entities. In template-encore these were Postgres
 * tables under Encore's SQLDatabase; here they live on the ledger (local
 * libSQL file / Turso replica) with UUIDs minted in JS instead of
 * gen_random_uuid().
 *
 * Emails are normalized to lowercase at the model boundary
 * (auth/user-model.ts), which is how the UNIQUE(email) column provides the
 * case-insensitive uniqueness the template got from lower(email).
 */
import { randomUUID } from "node:crypto";

import { Column, Entity } from "../core/ledger";

/**
 * `UserAccount` and `RefreshToken` used to live here and retired on 2026-08-03
 * (spec 004's rewrite, decided in spec 001 §5.3).
 *
 * They were the app's second opinion about a question rauthy already answers.
 * `UserAccount` minted a local id that became the session's subject, which is
 * why a `member.sub` recorded against rauthy could never match a session;
 * `RefreshToken` made this app the arbiter of whether a session was still
 * alive, so revoking a user at the IdP left them logged in here.
 *
 * The tables are not dropped: see the note in `store.ts`.
 */

/**
 * Durable, queryable audit trail. Writes are best-effort and never block the
 * user flow. Captures table/record/action, old/new state, actor, and origin.
 */
@Entity("audit_log")
export class AuditLog {
  @Column({ primary: true }) id = randomUUID();
  @Column({ index: true }) action = "";
  @Column({ nullable: true }) tableName: string | null = null;
  @Column({ nullable: true }) recordId: string | null = null;
  @Column({ type: "json", nullable: true }) oldData: unknown = null;
  @Column({ type: "json", nullable: true }) newData: unknown = null;
  @Column({ nullable: true }) actorId: string | null = null;
  @Column({ nullable: true }) actorEmail: string | null = null;
  @Column({ nullable: true }) ipAddress: string | null = null;
  @Column({ nullable: true }) userAgent: string | null = null;
  @Column({ type: "timestamp" }) createdAt = new Date();
}
