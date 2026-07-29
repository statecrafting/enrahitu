import { Service } from "encore.dev/service";

import { csrfMiddleware } from "../lib/csrf";
import { securityHeaders } from "../lib/security-headers";
import { obsMiddleware } from "../obs/middleware";

// The in-process hiqlite capability. Its only endpoint is now GET /hiq/health;
// the KV and counter demo surface retired with the SPA widget that consumed it
// (spec 001 §4.3), and with it the last reason for this service to hold any
// grant at all.
//
// **This service now holds zero capabilities** (`app-manifest.json`). That is
// the end state of the spec 025 §3.1 exploit path: the service that once held
// an unconstrained cap.counter.add, and therefore could forge the rate
// limiter's own buckets, can no longer touch the store through the kernel at
// all. `health()` demands nothing, so nothing needs granting. A future endpoint
// here starts from zero and has to justify each grant it adds.
//
// The middleware chain is kept despite the surface being one public GET.
// obsMiddleware is the observability contract (spec 022) and is not optional;
// securityHeaders and csrfMiddleware cost nothing on a GET and mean that an
// endpoint added here later is defended by default rather than by the author
// remembering. Still no rate limiter, for the reason spec 025 recorded:
// middleware runs under the mounting service's kernel attribution, so the
// limiter's rl:-prefixed writes would be adjudicated as hiq and denied.
export default new Service("hiq", {
  middlewares: [obsMiddleware, securityHeaders, csrfMiddleware],
});
