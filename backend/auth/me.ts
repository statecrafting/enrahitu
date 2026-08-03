/**
 * GET /api/v1/auth/me: the current principal, straight from the session.
 *
 * It used to read a `user_account` row by id. There is no such row now, and
 * that is the point rather than a shortcut: the app holds no opinion about who
 * a principal is that could drift from the IdP's. What the token says is what
 * the IdP said at most one access-token lifetime ago.
 *
 * The fields that retired with the table (`isActive`, `lastLoginAt`,
 * `createdAt`) were all answers this app was in no position to give: whether an
 * account is active is rauthy's to decide and it enforces it by refusing to
 * renew the session, and the dates described rows rather than people.
 */
import { api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";

import type { MeResponse } from "./types";

export const me = api(
  { expose: true, auth: true, method: "GET", path: "/api/v1/auth/me" },
  async (): Promise<MeResponse> => {
    const auth = getAuthData()!;
    return {
      id: auth.userID,
      email: auth.email,
      emailVerified: auth.emailVerified,
      name: auth.name,
      roles: auth.roles,
      ssoProvider: auth.ssoProvider,
    };
  },
);
