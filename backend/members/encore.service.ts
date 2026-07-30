import { Service } from "encore.dev/service";

import { csrfMiddleware } from "../lib/csrf";
import { obsMiddleware } from "../obs/middleware";
import { securityHeaders } from "../lib/security-headers";

import { startMembershipRuntimeOrExit } from "./boot";

// The association domain (spec 036). It publishes the endpoints the control
// plane deliberately does not (spec 034 §2), and it runs under its own kernel
// attribution, so a member-facing handler cannot borrow the control plane's
// ceiling by calling through it.
//
// It holds the same six state grants the control plane holds, because admission
// is adjudicated against the caller's service rather than against the module
// that implements it: db.read/db.write/db.txn on `state`, lock.acquire for the
// renewal lease, and notify.publish/notify.listen for the change hint. Narrowing
// those per kind is spec 020 §3.4's named extension and buys nothing today,
// since every kind shares one table (spec 034 §3.3).
//
// It does NOT hold db.migrate. Schema is a deploy step performed by an operator
// (spec 036 §3.6), and a domain service that could migrate is a domain service
// that could migrate by accident.
if (!process.env.VITEST) startMembershipRuntimeOrExit();

export default new Service("members", {
  middlewares: [obsMiddleware, securityHeaders, csrfMiddleware],
});
