/**
 * Gated serving of the dashboard bundle (spec 023 §3.2): every /admin
 * asset request is enforced server-side before bytes move. No operator
 * role, no bytes: signed-out gets the login redirect (this is a page, not
 * an API), a session without the operator role gets 403, and the runtime
 * kill switch (or an absent bundle, the admin="off" stamp) serves 404
 * indistinguishable from a route that never existed.
 *
 * api.static cannot run a role check, so this is a raw handler over
 * backend/web/dist-admin/ with a sanitized path join and an SPA fallback
 * to index.html for client-routed paths.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import { api } from "encore.dev/api";

import { ACCESS_COOKIE } from "../lib/cookie-config";
import { parseCookies } from "../lib/cookies";
import { env } from "../lib/env";
import { verifyAccessToken } from "../lib/jwt-verify";
import { hasRole, operatorRole } from "../lib/roles";

// cwd-relative, not module-relative: the bundled app runs from
// .encore/build/combined/ (same reasoning as lib/secrets.ts keysDir).
const distDir = join(process.cwd(), "backend", "web", "dist-admin");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function operatorFromCookie(cookieHeader: string | undefined): Promise<"ok" | "unauthenticated" | "forbidden"> {
  const token = parseCookies(cookieHeader ?? "")[ACCESS_COOKIE];
  if (!token) return "unauthenticated";
  try {
    const claims = await verifyAccessToken(token);
    return hasRole(claims.roles ?? [], operatorRole()) ? "ok" : "forbidden";
  } catch {
    return "unauthenticated";
  }
}

async function serveAdmin(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  rest: string,
): Promise<void> {
  if (!env.adminUiEnabled || !existsSync(join(distDir, "index.html"))) {
    res.statusCode = 404;
    res.end();
    return;
  }

  const verdict = await operatorFromCookie(req.headers.cookie);
  if (verdict === "unauthenticated") {
    res.statusCode = 302;
    res.setHeader("Location", "/api/v1/auth/login?redirect=%2Fadmin");
    res.end();
    return;
  }
  if (verdict === "forbidden") {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("403: this surface requires the operator role");
    return;
  }

  // Sanitize: resolve inside distDir only; anything escaping falls back to
  // the SPA index (which also serves client-routed paths).
  const cleaned = normalize(rest).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = join(distDir, cleaned);
  if (!filePath.startsWith(distDir + sep) && filePath !== distDir) filePath = join(distDir, "index.html");
  if (!existsSync(filePath) || !statSync(filePath).isFile()) filePath = join(distDir, "index.html");

  const ext = extname(filePath);
  res.statusCode = 200;
  res.setHeader("Content-Type", CONTENT_TYPES[ext] ?? "application/octet-stream");
  // Hashed assets may cache privately in the operator's browser; the HTML
  // shell must not (the role gate runs per request).
  res.setHeader(
    "Cache-Control",
    filePath.includes(`${sep}assets${sep}`) ? "private, max-age=31536000, immutable" : "no-store",
  );
  // pipeline destroys the read stream on a client abort (a bare pipe would
  // leak the fd) and rejects on a mid-stream read error.
  try {
    await pipeline(createReadStream(filePath), res);
  } catch {
    res.destroy();
  }
}

export const adminIndex = api.raw(
  { expose: true, method: "GET", path: "/admin" },
  async (req, res) => serveAdmin(req, res, "index.html"),
);

export const adminAssets = api.raw(
  { expose: true, method: "GET", path: "/admin/*rest" },
  async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const rest = decodeURIComponent(url.pathname.replace(/^\/admin\/?/, ""));
    await serveAdmin(req, res, rest === "" ? "index.html" : rest);
  },
);
