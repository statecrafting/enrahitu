/**
 * Driver discovery and the default-driver entry point. A driver is listed
 * only when its configuration is present.
 */
import { api } from "encore.dev/api";

import { ACCESS_COOKIE } from "../lib/cookie-config";
import { parseCookies } from "../lib/cookies";
import { env } from "../lib/env";
import { verifyAccessToken } from "../lib/jwt";

import { redirect, writeJson } from "./http";
import { isMockEnabled } from "./mock";
import { isRauthyConfigured } from "./rauthy";

export function configuredDrivers(): string[] {
  const drivers: string[] = [];
  if (isMockEnabled()) drivers.push("mock");
  if (isRauthyConfigured()) drivers.push("rauthy");
  return drivers;
}

export const drivers = api(
  { expose: true, method: "GET", path: "/api/v1/auth/drivers" },
  async (): Promise<{ drivers: string[] }> => ({ drivers: configuredDrivers() }),
);

// status is raw so it never returns 401: it simply reports whether the
// caller's access cookie is currently valid.
export const status = api.raw(
  { expose: true, method: "GET", path: "/api/v1/auth/status" },
  async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    let authenticated = false;
    const token = cookies[ACCESS_COOKIE];
    if (token) {
      try {
        await verifyAccessToken(token);
        authenticated = true;
      } catch {
        authenticated = false;
      }
    }
    writeJson(res, 200, { authenticated, drivers: configuredDrivers() });
  },
);

// Redirect to the configured default driver's login.
export const login = api.raw(
  { expose: true, method: "GET", path: "/api/v1/auth/login" },
  async (_req, res) => {
    redirect(res, `/api/v1/auth/${env.authDriver}/login`);
  },
);
