/** Identity surfaced by the authHandler to every auth:true endpoint. */
export interface AuthData {
  /**
   * The identity provider's `sub`, and therefore the principal identifier the
   * domain binds to (spec 001 §5.3). Before the 2026-08-03 rewrite this was a
   * locally minted account id, which is why `member.sub` never matched.
   */
  userID: string;
  email: string;
  /** Whether the IdP verified the address. An authorization input (spec 036 §3.8). */
  emailVerified: boolean;
  name: string;
  roles: string[];
  ssoProvider: string;
}

/**
 * What a driver returns about the principal it just authenticated.
 *
 * There is no local account row behind this any more. The profile IS the
 * principal: `subject` is the authority's own identifier and nothing is minted
 * alongside it.
 */
export interface SSOProfile {
  ssoProvider: string;
  /** The authority's `sub`. This becomes the session's subject verbatim. */
  subject: string;
  email: string;
  /**
   * Only ever true when the IdP said so. A driver that cannot tell must say
   * false: the member plane treats a verified address as proof of control.
   */
  emailVerified: boolean;
  name: string;
  roles: string[];
  attributes?: Record<string, unknown>;
}

/** Bare profile payload returned by GET /api/v1/auth/me. */
export interface MeResponse {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  roles: string[];
  ssoProvider: string;
}
