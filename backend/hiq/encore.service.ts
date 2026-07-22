import { Service } from "encore.dev/service";

import { obsMiddleware } from "../obs/middleware";

// In-process hiqlite capability: cache/KV with TTL + replicated counters.
// Instrumented (spec 022).
export default new Service("hiq", { middlewares: [obsMiddleware] });
