import { Service } from "encore.dev/service";

// The state layer has no endpoints, and that is the design rather than a stage
// it has not reached yet. hiqlite is a library, not an API: spec 015 retired the
// hiq service's KV and counter endpoints precisely because publishing a store
// over HTTP adds a second, weaker path to it, next to the in-process one where
// admission actually runs. This service exists to give the state layer a name in
// the app model, so the migration grants have a holder that is not some unrelated
// service that happens to run schema changes.
//
// It holds exactly two capabilities (`app-manifest.json`): db.migrate and
// db.read on `state`. It owns the schema, so it may change the schema and read
// what version it is at. It cannot write a row, take a lease, publish a notify,
// or touch a backup. Those grants are declared and deliberately unheld until
// phase 3's control plane exists to justify each one.
export default new Service("state");
