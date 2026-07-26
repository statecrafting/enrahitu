import { Service } from "encore.dev/service";

import { csrfMiddleware } from "../lib/csrf";
import { securityHeaders } from "../lib/security-headers";
import { obsMiddleware } from "../obs/middleware";

// In-process hiqlite capability: cache/KV with TTL + replicated counters.
// Instrumented (spec 022). This service previously carried obsMiddleware
// alone while exposing unauthenticated writes into the raft-replicated store
// (spec 025 §3.1); observation outermost so spans and request metrics cover
// the whole chain.
//
// The admin service's chain, not the auth service's. No rate limiter: this is
// an operator-only surface behind the role gate, and mounting apiRateLimit
// here would run its rl:-prefixed counter writes under hiq's attribution.
// Scoped to demo:, those writes are denied and the limiter fails open,
// enforcing nothing; widening hiq to hold the rl: grant as well would let the
// demo endpoints satisfy it and reopen the bucket forgery this gating closes.
export default new Service("hiq", {
  middlewares: [obsMiddleware, securityHeaders, csrfMiddleware],
});
