import { Service } from "encore.dev/service";

// No middleware (template-encore spec 005 pattern): static assets must cache
// normally, so the no-store securityHeaders middleware is deliberately
// omitted here.
export default new Service("web");
