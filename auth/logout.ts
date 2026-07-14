/**
 * POST /api/v1/auth/logout: revoke the active refresh token, clear cookies,
 * and return a redirect target. auth:true and CSRF-checked.
 */
import { api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";

import { writeAudit } from "../lib/audit";
import { REFRESH_COOKIE } from "../lib/cookie-config";
import { clearAuthCookies, parseCookies } from "../lib/cookies";

import { clientIp, userAgent, writeJson } from "./http";
import { findActiveRefreshToken, revokeRefreshToken } from "./refresh-token-model";
import { frontendUrl } from "./service";

export const logout = api.raw(
  { expose: true, auth: true, method: "POST", path: "/api/v1/auth/logout" },
  async (req, res) => {
    const auth = getAuthData();
    const presented = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
    if (presented) {
      const active = await findActiveRefreshToken(presented);
      if (active) await revokeRefreshToken(active.id);
    }
    if (auth) {
      await writeAudit({
        action: "auth.logout",
        actorId: auth.userID,
        actorEmail: auth.email,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });
    }
    clearAuthCookies(res);
    writeJson(res, 200, { redirectUrl: frontendUrl("/") });
  },
);
