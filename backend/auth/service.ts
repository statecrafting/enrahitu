/**
 * Shared login finalization: mint the RS256 token pair, persist the
 * refresh-token hash, set httpOnly cookies, and write the best-effort login
 * audit record.
 */
import type { ServerResponse } from "node:http";

import { writeAudit } from "../lib/audit";
import { setAuthCookies } from "../lib/cookies";
import { env } from "../lib/env";
import { signAccessToken, signRefreshToken } from "../lib/jwt";

import type { UserAccount } from "./entities";
import { storeRefreshToken } from "./refresh-token-model";
import type { SSOProfile } from "./types";
import { upsertUserFromProfile } from "./user-model";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export async function issueTokenPair(
  user: UserAccount,
  meta?: { ipAddress?: string; userAgent?: string },
): Promise<TokenPair> {
  const accessToken = await signAccessToken({
    userID: user.id,
    email: user.email,
    name: user.name,
    roles: user.roles,
    ssoProvider: user.ssoProvider,
  });
  const refresh = await signRefreshToken(user.id);
  await storeRefreshToken({
    userID: user.id,
    token: refresh.token,
    expiresAt: refresh.expiresAt,
    userAgent: meta?.userAgent,
    ipAddress: meta?.ipAddress,
  });
  return { accessToken, refreshToken: refresh.token };
}

export async function finalizeLogin(
  res: ServerResponse,
  profile: SSOProfile,
  meta?: { ipAddress?: string; userAgent?: string },
): Promise<UserAccount> {
  const user = await upsertUserFromProfile(profile);
  const pair = await issueTokenPair(user, meta);
  setAuthCookies(res, pair);
  await writeAudit({
    action: "auth.login",
    tableName: "user_account",
    recordId: user.id,
    actorId: user.id,
    actorEmail: user.email,
    ipAddress: meta?.ipAddress,
    userAgent: meta?.userAgent,
    newData: { ssoProvider: profile.ssoProvider },
  });
  return user;
}

export function frontendUrl(path = "/"): string {
  return new URL(path, env.frontendUrl).toString();
}
