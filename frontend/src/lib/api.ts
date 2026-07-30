/**
 * Thin client over the enrahitu API. Auth rides httpOnly cookies, so every
 * request is plain fetch with same-origin credentials; nothing token-like is
 * ever visible to this code. State-changing calls replay the CSRF token from
 * GET /api/v1/auth/csrf-token as the X-CSRF-Token header (double-submit).
 *
 * This module is the SPA's only network surface. Everything it touches is
 * same-origin (spec 005): the API under /api/v1, and the IdP under /auth,
 * proxied by the backend so the browser never sees a second origin.
 */

export interface AuthStatus {
  authenticated: boolean;
  drivers: string[];
}

export interface Me {
  id: string;
  email: string;
  name: string;
  roles: string[];
  ssoProvider: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) throw Object.assign(new Error(`GET ${path}: ${res.status}`), { status: res.status });
  return (await res.json()) as T;
}

export function fetchStatus(): Promise<AuthStatus> {
  return get<AuthStatus>("/api/v1/auth/status");
}

async function fetchMeOnce(): Promise<Me> {
  return get<Me>("/api/v1/auth/me");
}

async function refresh(): Promise<boolean> {
  const res = await fetch("/api/v1/auth/refresh", {
    method: "POST",
    credentials: "same-origin",
  });
  return res.ok;
}

/** Profile with one silent-refresh retry on an expired access token. */
export async function fetchMe(): Promise<Me | null> {
  try {
    return await fetchMeOnce();
  } catch (err) {
    if ((err as { status?: number }).status !== 401) throw err;
    if (!(await refresh())) return null;
    try {
      return await fetchMeOnce();
    } catch {
      return null;
    }
  }
}

/** The double-submit token, shared with the membership client (spec 036). */
export async function csrfToken(): Promise<string> {
  const { token } = await get<{ token: string }>("/api/v1/auth/csrf-token");
  return token;
}

export async function logout(): Promise<{ redirectUrl: string }> {
  const token = await csrfToken();
  const res = await fetch("/api/v1/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-CSRF-Token": token },
  });
  return (await res.json()) as { redirectUrl: string };
}
