import { Service } from "encore.dev/service";

// The lib service has no endpoints. It hosts secret() declarations, shared
// middleware (security headers, CSRF, rate limiting), and the security
// primitives every other service builds on.
export default new Service("lib");
