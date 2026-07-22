/**
 * The admin gate (spec 023 §3.1-3.2): every admin surface passes both
 * checks. The runtime kill switch answers 404 (off means absent,
 * indistinguishable from a stamp without the slot); the role gate answers
 * permissionDenied. The operator role name is the model's
 * auth.operatorRole (stamp-time truth), enrahitu_operator in the template.
 */
import { APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";

import { env } from "../lib/env";
import { operatorRole, requireRole } from "../lib/roles";

export function requireAdminEnabled(): void {
  if (!env.adminUiEnabled) throw APIError.notFound("not found");
}

/** Typed-endpoint gate: kill switch, then the operator role. */
export function requireOperator(): void {
  requireAdminEnabled();
  requireRole(getAuthData()!, operatorRole());
}
