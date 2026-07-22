/**
 * GET /metrics (spec 022 §3.1): Prometheus text format from the in-process
 * registry. Part of the app, always on (the contract is non-negotiable, no
 * flag), and unauthenticated at the app layer: deployment guidance keeps it
 * off the public ingress (spec 007/010/012 line).
 */
import { api } from "encore.dev/api";

import { metricsContentType, renderMetrics } from "./metrics";

export const metrics = api.raw(
  { expose: true, method: "GET", path: "/metrics" },
  async (_req, resp) => {
    resp.setHeader("Content-Type", metricsContentType);
    resp.end(await renderMetrics());
  },
);
