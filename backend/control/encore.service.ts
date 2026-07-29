import { Service } from "encore.dev/service";

// The control plane has no endpoints of its own, and that is the same decision
// the state layer made one level down: it is a library that application code
// calls in-process, not an API. The association domain (phase 5) publishes the
// endpoints, and each of those runs under its own service's attribution, so a
// member-facing handler cannot borrow the control plane's ceiling by calling
// through it.
//
// It holds the six grants a control plane genuinely needs and no more:
// db.read/db.write/db.txn on `state` (list, watermark, admit), lock.acquire
// (the controller lease), and notify.publish/notify.listen (the change hint in
// both directions). It does NOT hold db.migrate: schema is the state service's,
// which is why CONTROL_PLANE_MIGRATIONS is exported as data for the migration
// runner rather than applied from here.
//
// It also does not hold the backup grants. Bracketing a risky operation with a
// backup is an operator verb (spec 027), and a controller that could take a
// backup on its own schedule would be a controller that can fill a volume.
export default new Service("control");
