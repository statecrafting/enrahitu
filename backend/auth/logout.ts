/**
 * POST /api/v1/auth/logout: drop the session and send the browser to the
 * authority to end it there too. auth:true and CSRF-checked.
 *
 * There is no local revocation step any more, because there is nothing local to
 * revoke: clearing the cookies discards the only copy of the IdP's refresh
 * token this app ever held. **The RP-initiated redirect below is therefore no
 * longer a courtesy but the actual logout** (spec 005), since it is what ends
 * the session at the authority; without it the browser would still hold a live
 * rauthy session and the next login would silently succeed with no prompt.
 */
import { api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";

import { writeAudit } from "../lib/audit";
import { OIDC_ID_HINT_COOKIE } from "../lib/cookie-config";
import { clearAuthCookies, parseCookies } from "../lib/cookies";

import { clientIp, userAgent, writeJson } from "./http";
import { isRauthyConfigured, rauthyEndSessionUrl } from "./rauthy";
import { frontendUrl } from "./service";

export const logout = api.raw(
  { expose: true, auth: true, method: "POST", path: "/api/v1/auth/logout" },
  async (req, res) => {
    const auth = getAuthData();
    const cookies = parseCookies(req.headers.cookie);
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
