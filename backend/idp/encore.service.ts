import { Service } from "encore.dev/service";

import { obsMiddleware } from "../obs/middleware";

// Same-origin identity-provider proxy: mounts rauthy under this app's /auth/*
// so issuer, login UI, and OIDC callbacks share one public origin (one
// exposed port, no CORS between app and IdP). Deliberately NO auth service
// middlewares: rauthy manages its own sessions, CSRF, and headers. The obs
// middleware is measurement only (spec 022) and changes none of that.
export default new Service("idp", { middlewares: [obsMiddleware] });
