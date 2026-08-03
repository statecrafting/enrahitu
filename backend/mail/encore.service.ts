import { Service } from "encore.dev/service";

import { csrfMiddleware } from "../lib/csrf";
import { obsMiddleware } from "../obs/middleware";
import { securityHeaders } from "../lib/security-headers";

import { startMailRuntimeOrLog } from "./boot";

// The application's outbound channel (spec 037). It holds its own kernel
// attribution so that `smtp.egress` is granted to the one service that opens a
// socket, and to nothing else: a domain service that could reach the transport
// could send inside a request.
//
// Its state grants are the control plane's minus db.migrate, for the same reason
// the members service's are (spec 036): schema is a deploy step. It additionally
// holds `cap.smtp.mail-relay` and `cap.secret.mail-password`, which are the two
// grants that make this service different from every other one in the tree.
if (!process.env.VITEST) startMailRuntimeOrLog();

export default new Service("mail", {
  middlewares: [obsMiddleware, securityHeaders, csrfMiddleware],
});
