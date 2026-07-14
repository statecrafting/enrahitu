/**
 * Thin client over the enrahitu API. Auth rides httpOnly cookies, so every
 * request is plain fetch with same-origin credentials; nothing token-like is
 * ever visible to this code. State-changing calls replay the CSRF token from
 * GET /api/v1/auth/csrf-token as the X-CSRF-Token header (double-submit).
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

async function csrfToken(): Promise<string> {
  const { token } = await get<{ token: string }>("/api/v1/auth/csrf-token");
  return token;
}

export async function logout(): Promise<void> {
  const token = await csrfToken();
  await fetch("/api/v1/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-CSRF-Token": token },
  });
}

export interface KvRoundTrip {
  stored: string;
  readBack: string | null;
}

/** Round-trip a value through the embedded hiqlite cache (60s TTL). */
export async function kvRoundTrip(key: string, value: string): Promise<KvRoundTrip> {
  await fetch("/hiq/kv", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value, ttlSecs: 60 }),
  });
  const { value: readBack } = await get<{ value: string | null }>(
    `/hiq/kv/${encodeURIComponent(key)}`,
  );
  return { stored: value, readBack };
}
