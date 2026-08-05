// Types for the operator session the verbs reach the admin plane on
// (spec 027 §3.2, §3.4).

export type Env = Record<string, string | undefined>;

export declare const DEFAULT_APP_URL: string;

export declare const CSRF_COOKIE: string;

/** Read a cookie out of a Set-Cookie list or a Cookie header, prefix-tolerant. */
export declare function cookieFrom(
  source: string | string[] | undefined,
  name: string,
): string | undefined;
export declare function appUrl(env: Env): string;

/** Obtain a CSRF token the way the SPA does, with the cookie to send beside it. */
export declare function acquireCsrf(
  env: Env,
  cookie: string,
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<{ token: string; cookie: string }>;

export declare function adminRequest(
  env: Env,
  path: string,
  opts?: {
    method?: string;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  },
): Promise<Record<string, any>>;
