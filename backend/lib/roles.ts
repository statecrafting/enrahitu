/**
 * Role checks with any-of semantics.
 *
 * Roles are a set (string[]), never a privilege hierarchy. A caller satisfies
 * a requirement if it holds ANY of the required roles.
 */
import { APIError } from "encore.dev/api";

import { modelJson } from "../kernel/boot";

/**
 * The <app>_operator role convention (spec 001 §4.4, spec 023): read from
 * the booted model's auth.operatorRole so a stamped app gates on its own
 * name, never on a string frozen at template time.
 */
export function operatorRole(): string {
  const model = JSON.parse(modelJson) as { auth?: { operatorRole?: string } };
  return model.auth?.operatorRole ?? "enrahitu_operator";
}

export function hasRole(roles: string[], required: string | string[]): boolean {
  const needed = Array.isArray(required) ? required : [required];
  if (needed.length === 0) return true;
  return needed.some((role) => roles.includes(role));
}

export function requireRole(auth: { roles: string[] }, required: string | string[]): void {
  if (!hasRole(auth.roles, required)) {
    const needed = Array.isArray(required) ? required : [required];
    throw APIError.permissionDenied("insufficient role").withDetails({
      code: "ROLE_REQUIRED",
      required: needed,
    });
  }
}
