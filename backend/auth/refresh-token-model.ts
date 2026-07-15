/**
 * Refresh-token persistence. Only the SHA-256 hash of a token is stored;
 * rotation marks the presented token revoked and links it to its replacement.
 * Expiry is compared in JS after the hash lookup (CoreLedger's query surface
 * is equality-only by design).
 */
import { hashRefreshToken } from "../lib/jwt";

import { RefreshToken } from "./entities";
import { dbReady, ledger } from "./store";

export async function storeRefreshToken(params: {
  userID: string;
  token: string;
  expiresAt: Date;
  userAgent?: string;
  ipAddress?: string;
}): Promise<string> {
  await dbReady;
  const record = Object.assign(new RefreshToken(), {
    userId: params.userID,
    tokenHash: hashRefreshToken(params.token),
    expiresAt: params.expiresAt,
    userAgent: params.userAgent ?? null,
    ipAddress: params.ipAddress ?? null,
  });
  await ledger().repo(RefreshToken).insert(record);
  return record.id;
}

export async function findActiveRefreshToken(token: string): Promise<RefreshToken | null> {
  await dbReady;
  const found = await ledger()
    .repo(RefreshToken)
    .findOne({ tokenHash: hashRefreshToken(token), revokedAt: null } as Partial<RefreshToken>);
  if (!found) return null;
  return found.expiresAt.getTime() > Date.now() ? found : null;
}

export async function revokeRefreshToken(id: string, replacedBy?: string): Promise<void> {
  await dbReady;
  const repo = ledger().repo(RefreshToken);
  const current = await repo.findById(id);
  if (!current || current.revokedAt !== null) return;
  await repo.updateById(id, { revokedAt: new Date(), replacedBy: replacedBy ?? null });
}

export async function revokeAllUserTokens(userID: string): Promise<void> {
  await dbReady;
  const repo = ledger().repo(RefreshToken);
  const active = await repo.findWhere({ userId: userID, revokedAt: null } as Partial<RefreshToken>);
  const now = new Date();
  for (const token of active) {
    await repo.updateById(token.id, { revokedAt: now });
  }
}
