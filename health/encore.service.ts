import { Service } from "encore.dev/service";

// Liveness/readiness surface for the whole app.
export default new Service("health");
