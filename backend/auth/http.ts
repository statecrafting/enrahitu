/**
 * Small helpers for the auth service's api.raw handlers (cookie/redirect/SSO
 * flows that need direct access to the Node request and response).
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { clientAddress } from "../lib/client-identity";

/**
 * The caller's address, forge-proof by construction (spec 025 §3.2). This
 * previously preferred X-Forwarded-For over the socket it already held, so
 * the auth-tier rate limiter (the one guarding brute force and lockout)
 * counted a value the caller chose. Raw handlers have a socket, so this
 * always resolves: the vouched forwarded entry when a proxy is declared, the
 * transport peer otherwise.
 */
export function clientIp(req: IncomingMessage): string | undefined {
  return clientAddress(req.headers, req.socket?.remoteAddress ?? undefined);
}

export function userAgent(req: IncomingMessage): string | undefined {
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] : ua;
}

export function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

export async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function parseFormBody(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const out: Record<string, string> = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}
