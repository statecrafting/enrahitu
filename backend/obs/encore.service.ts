import { Service } from "encore.dev/service";

// The observability service (spec 022): /metrics plus the in-process trace
// plane. Deliberately NO middlewares, including its own obsMiddleware: a
// scrape must not generate spans or count itself, or the trace buffer fills
// with self-observation instead of traffic.
export default new Service("obs");
