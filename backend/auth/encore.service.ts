import { Service } from "encore.dev/service";

import { csrfMiddleware } from "../lib/csrf";
import { apiRateLimit } from "../lib/rate-limit";
import { securityHeaders } from "../lib/security-headers";
import { obsMiddleware } from "../obs/middleware";

// Middlewares run in declaration order; obsMiddleware sits outermost so
// spans and request metrics cover the whole chain (spec 022). SSO callbacks
// and /auth/refresh are CSRF-exempt (handled inside csrfMiddleware).
export default new Service("auth", {
  middlewares: [obsMiddleware, securityHeaders, csrfMiddleware, apiRateLimit],
});
