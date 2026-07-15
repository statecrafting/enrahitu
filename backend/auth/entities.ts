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

/** One row per authenticated principal across all SSO drivers. */
@Entity("user_account")
export class UserAccount {
  @Column({ primary: true }) id = randomUUID();
  @Column({ unique: true }) email = "";
  @Column() name = "";
  /** Multi-role set with any-of membership, never a hierarchy. */
  @Column({ type: "json" }) roles: string[] = ["user"];
  @Column() ssoProvider = "";
  @Column({ nullable: true, index: true }) ssoProviderId: string | null = null;
  @Column({ type: "json" }) attributes: Record<string, unknown> = {};
  @Column({ type: "boolean" }) isActive = true;
  @Column({ type: "timestamp", nullable: true }) lastLoginAt: Date | null = null;
  @Column({ type: "timestamp" }) createdAt = new Date();
  @Column({ type: "timestamp" }) updatedAt = new Date();
}

/**
 * Hash-only refresh-token store with rotation and server-side revocation.
 * The raw refresh token is never persisted: only its SHA-256 hash.
 */
@Entity("refresh_token")
export class RefreshToken {
  @Column({ primary: true }) id = randomUUID();
  @Column({ index: true }) userId = "";
  @Column({ unique: true }) tokenHash = "";
  @Column({ type: "timestamp" }) issuedAt = new Date();
  @Column({ type: "timestamp" }) expiresAt = new Date();
  @Column({ type: "timestamp", nullable: true }) revokedAt: Date | null = null;
  @Column({ nullable: true }) replacedBy: string | null = null;
  @Column({ nullable: true }) userAgent: string | null = null;
  @Column({ nullable: true }) ipAddress: string | null = null;
}

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
