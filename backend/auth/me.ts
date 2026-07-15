/**
 * GET /api/v1/auth/me: the current principal's bare profile. auth:true, so
 * the Gateway authHandler has already populated AuthData.
 */
import { APIError, api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";

import type { MeResponse } from "./types";
import { getUserById } from "./user-model";

export const me = api(
  { expose: true, auth: true, method: "GET", path: "/api/v1/auth/me" },
  async (): Promise<MeResponse> => {
    const auth = getAuthData()!;
    const user = await getUserById(auth.userID);
    if (!user) {
      throw APIError.notFound("user not found");
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roles: user.roles,
      ssoProvider: user.ssoProvider,
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      createdAt: user.createdAt.toISOString(),
    };
  },
);
