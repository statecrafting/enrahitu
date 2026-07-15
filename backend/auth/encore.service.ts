import { Service } from "encore.dev/service";

import { csrfMiddleware } from "../lib/csrf";
import { apiRateLimit } from "../lib/rate-limit";
import { securityHeaders } from "../lib/security-headers";

// Middlewares run in declaration order. SSO callbacks and /auth/refresh are
// CSRF-exempt (handled inside csrfMiddleware).
export default new Service("auth", {
  middlewares: [securityHeaders, csrfMiddleware, apiRateLimit],
});
