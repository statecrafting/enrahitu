/**
 * POST /api/v1/auth/logout: revoke the active refresh token, clear cookies,
 * and return a redirect target. auth:true and CSRF-checked.
 */
import { api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";

import { writeAudit } from "../lib/audit";
import { OIDC_ID_HINT_COOKIE, REFRESH_COOKIE } from "../lib/cookie-config";
import { clearAuthCookies, parseCookies } from "../lib/cookies";

import { clientIp, userAgent, writeJson } from "./http";
import { isRauthyConfigured, rauthyEndSessionUrl } from "./rauthy";
import { findActiveRefreshToken, revokeRefreshToken } from "./refresh-token-model";
import { frontendUrl } from "./service";

export const logout = api.raw(
  { expose: true, auth: true, method: "POST", path: "/api/v1/auth/logout" },
  async (req, res) => {
    const auth = getAuthData();
    const cookies = parseCookies(req.headers.cookie);
    const presented = cookies[REFRESH_COOKIE];
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
    // RP-initiated logout (spec 005, amendment 2026-07-23): with a hint
    // and a configured driver, send the browser through rauthy's
    // end-session endpoint; otherwise the frontend root as before.
    const idHint = cookies[OIDC_ID_HINT_COOKIE];
    const redirectUrl =
      idHint && isRauthyConfigured() ? rauthyEndSessionUrl(idHint) : frontendUrl("/");
    clearAuthCookies(res);
    writeJson(res, 200, { redirectUrl });
  },
);
