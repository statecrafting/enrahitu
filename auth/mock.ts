/**
 * Mock SSO driver (development/test only). Provides three principals so each
 * default role can be exercised without a real IdP. Disabled in production.
 */
import { api } from "encore.dev/api";

import { env } from "../lib/env";
import { withinAuthRateLimit } from "../lib/rate-limit";

import { clientIp, redirect, requestUrl, userAgent } from "./http";
import { finalizeLogin, frontendUrl } from "./service";
import type { SSOProfile } from "./types";

export function isMockEnabled(): boolean {
  return !env.isProduction;
}

const MOCK_USERS: SSOProfile[] = [
  {
    ssoProvider: "mock",
    ssoProviderId: "mock-user",
    email: "user@example.com",
    name: "Casey User",
    roles: ["user"],
    attributes: { department: "General" },
  },
  {
    ssoProvider: "mock",
    ssoProviderId: "mock-admin",
    email: "admin@example.com",
    name: "Avery Admin",
    roles: ["user", "admin"],
    attributes: { department: "Administration" },
  },
  {
    ssoProvider: "mock",
    ssoProviderId: "mock-developer",
    email: "dev@example.com",
    name: "Devon Developer",
    roles: ["user", "developer"],
    attributes: { department: "Engineering" },
  },
];

export const mockLogin = api.raw(
  { expose: true, method: "GET", path: "/api/v1/auth/mock/login" },
  async (req, res) => {
    if (!isMockEnabled()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (!(await withinAuthRateLimit(clientIp(req)))) {
      res.statusCode = 429;
      res.setHeader("Retry-After", "60");
      res.end("rate limit exceeded");
      return;
    }
    const raw = requestUrl(req).searchParams.get("user");
    const index = raw !== null && Number.isInteger(Number(raw)) ? Number(raw) : 0;
    const profile = MOCK_USERS[index] ?? MOCK_USERS[0]!;
    await finalizeLogin(res, profile, { ipAddress: clientIp(req), userAgent: userAgent(req) });
    redirect(res, frontendUrl("/"));
  },
);
