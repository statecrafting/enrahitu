/**
 * Small helpers for the auth service's api.raw handlers (cookie/redirect/SSO
 * flows that need direct access to the Node request and response).
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export function clientIp(req: IncomingMessage): string | undefined {
  const xff = req.headers["x-forwarded-for"];
  const value = Array.isArray(xff) ? xff[0] : xff;
  if (value) return value.split(",")[0]!.trim();
  return req.socket?.remoteAddress ?? undefined;
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
