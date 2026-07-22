import { Service } from "encore.dev/service";

import { csrfMiddleware } from "../lib/csrf";
import { securityHeaders } from "../lib/security-headers";
import { obsMiddleware } from "../obs/middleware";

// The admin data plane (spec 023): same-origin operator surface, gated
// server-side on the <app>_operator role in every handler. Observation
// outermost (spec 022); securityHeaders because nothing here is publicly
// cacheable; CSRF for any future unsafe method (safe methods are exempt).
// No rate limiter: this is an operator-only surface behind the role gate.
export default new Service("admin", {
  middlewares: [obsMiddleware, securityHeaders, csrfMiddleware],
});
