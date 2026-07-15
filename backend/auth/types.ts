/** Identity surfaced by the authHandler to every auth:true endpoint. */
export interface AuthData {
  userID: string;
  email: string;
  name: string;
  roles: string[];
  ssoProvider: string;
}

/** Normalized profile a driver returns before it is resolved to a user_account row. */
export interface SSOProfile {
  ssoProvider: string;
  ssoProviderId: string;
  email: string;
  name: string;
  roles: string[];
  attributes?: Record<string, unknown>;
}

/** Bare profile payload returned by GET /api/v1/auth/me. */
export interface MeResponse {
  id: string;
  email: string;
  name: string;
  roles: string[];
  ssoProvider: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}
