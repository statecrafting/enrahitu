/**
 * GET /metrics (spec 022 §3.1): Prometheus text format from the in-process
 * registry. Part of the app, always on (the contract is non-negotiable, no
 * flag).
 *
 * Authentication was added by spec 025 §3.4 without adding a flag: the
 * endpoint is still always on and still unflagged. Its previous comment
 * claimed "deployment guidance keeps it off the public ingress", and no such
 * guidance existed anywhere in the repository, so the control was documented
 * but never implemented.
 *
 * ENRAHITU_METRICS_TOKEN, when set, requires a bearer token. first-boot.mjs
 * provisions one in the packaged image, so the secure state is the default
 * there; when unset (npm run dev, the test suite) the endpoint serves
 * unauthenticated as before.
 */
import { api } from "encore.dev/api";

import { metricsContentType, renderMetrics } from "./metrics";
import { metricsAuthorized } from "./metrics-auth";

export const metrics = api.raw(
  { expose: true, method: "GET", path: "/metrics" },
  async (req, resp) => {
    if (!metricsAuthorized(req.headers["authorization"], process.env.ENRAHITU_METRICS_TOKEN)) {
      resp.statusCode = 401;
      resp.setHeader("WWW-Authenticate", "Bearer");
      resp.setHeader("Content-Type", "application/json");
      resp.end(JSON.stringify({ code: "unauthenticated", message: "metrics token required" }));
      return;
    }

    resp.setHeader("Content-Type", metricsContentType);
    resp.end(await renderMetrics());
  },
);
