/**
 * POST /api/v1/auth/refresh: rotate the token pair. CSRF-exempt (it cannot
 * carry a prior-issued token). Issues a new pair, revokes the presented
 * refresh token, and writes a best-effort audit record.
 */
import { api } from "encore.dev/api";

import { writeAudit } from "../lib/audit";
import { REFRESH_COOKIE } from "../lib/cookie-config";
import { clearAuthCookies, parseCookies, setAuthCookies } from "../lib/cookies";
import { verifyRefreshToken } from "../lib/jwt";

import { clientIp, userAgent, writeJson } from "./http";
import { findActiveRefreshToken, revokeRefreshToken } from "./refresh-token-model";
import { issueTokenPair } from "./service";
import { getUserById } from "./user-model";

function deny(res: Parameters<typeof clearAuthCookies>[0], message: string): void {
  clearAuthCookies(res);
  writeJson(res, 401, { code: "unauthenticated", message });
}

export const refresh = api.raw(
  { expose: true, method: "POST", path: "/api/v1/auth/refresh" },
  async (req, res) => {
    const presented = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
    if (!presented) return deny(res, "no refresh token");

    let userID: string;
    try {
      ({ userID } = await verifyRefreshToken(presented));
    } catch {
      return deny(res, "invalid refresh token");
    }

    const active = await findActiveRefreshToken(presented);
    if (!active) return deny(res, "refresh token revoked or expired");

    const user = await getUserById(userID);
    if (!user) return deny(res, "user not found");

    const meta = { ipAddress: clientIp(req), userAgent: userAgent(req) };
    const pair = await issueTokenPair(user, meta);
    await revokeRefreshToken(active.id);
    setAuthCookies(res, pair);
    await writeAudit({ action: "auth.refresh", actorId: user.id, actorEmail: user.email, ...meta });
    writeJson(res, 200, { status: "ok" });
  },
);
