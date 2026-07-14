import { Service } from "encore.dev/service";

// In-process hiqlite capability: cache/KV with TTL + replicated counters.
export default new Service("hiq");
