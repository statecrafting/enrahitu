import { Service } from "encore.dev/service";

import { obsMiddleware } from "../obs/middleware";

// Liveness/readiness surface for the whole app. Instrumented (spec 022).
export default new Service("health", { middlewares: [obsMiddleware] });
