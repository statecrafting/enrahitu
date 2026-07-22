/**
 * The live trace stream (spec 023 §3.3): SSE over the spec 022 buffer's
 * subscription surface. Replaces the daemon's trace/new notification with
 * plain HTTP: one completed-trace summary per event, a comment heartbeat
 * to keep intermediaries from idling the connection out, cleanup on
 * client close.
 */
import { api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";

import { env } from "../lib/env";
import { hasRole, operatorRole } from "../lib/roles";
import { onTrace } from "../obs/traces";

const HEARTBEAT_MS = 15_000;

export const traceStream = api.raw(
  { expose: true, auth: true, method: "GET", path: "/api/admin/traces/stream/live" },
  async (_req, res) => {
    if (!env.adminUiEnabled) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const auth = getAuthData();
    if (!auth || !hasRole(auth.roles, operatorRole())) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: "permission_denied", message: "insufficient role" }));
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.write(`retry: 3000\n\n`);

    const heartbeat = setInterval(() => {
      res.write(`: ping\n\n`);
    }, HEARTBEAT_MS);
    const unsubscribe = onTrace((trace) => {
      res.write(
        `event: trace\ndata: ${JSON.stringify({
          traceId: trace.traceId,
          rootName: trace.rootName,
          startMs: trace.startMs,
          endMs: trace.endMs,
          spanCount: trace.spans.length,
          hasError: trace.hasError,
        })}\n\n`,
      );
    });

    await new Promise<void>((done) => {
      res.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
        done();
      });
    });
  },
);
