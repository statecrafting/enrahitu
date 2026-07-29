/**
 * The control plane (spec 034): typed, tenant-scoped resources admitted through
 * the kernel, watched by revision, reconciled by leased controllers, and
 * recorded in the Decision chain.
 *
 * This is the layer spec 001 calls "application code holds intent and
 * reconciliation". It sits on the state layer (spec 032) and holds no addon
 * import of its own: every store crossing goes through `backend/state/`, which
 * adjudicates it.
 *
 * The shape is deliberately the one Kubernetes made ordinary, because it is the
 * shape that survives a lease that expires under you and a notify that never
 * arrives: desired state is a row, observed state is a status, and a controller
 * converges the second toward the first, repeatedly and idempotently. Nothing
 * here applies a change once and assumes it took.
 */
export {
  admit,
  retract,
  get,
  list,
  SupersededError,
  TenancyError,
  type AdmitOptions,
  type Op,
  type Resource,
} from "./admission";

export {
  registerKind,
  requireKind,
  registeredKinds,
  resetKindsForTest,
  InvalidSpecError,
  requireEnum,
  requireObject,
  requireString,
  optionalString,
  type Kind,
} from "./kinds";

export { changesSince, waker, type Change, type WatchOptions } from "./watch";

export {
  startController,
  runOnce,
  type ControllerSpec,
  type ReconcileContext,
  type RunningController,
} from "./controller";

export {
  CONTROL_PLANE_MIGRATIONS,
  OUTBOX_TABLE,
  RESOURCE_TABLE,
  WATERMARK_TABLE,
} from "./schema";

export { hydrateRow, type ResourceRow } from "./rows";
