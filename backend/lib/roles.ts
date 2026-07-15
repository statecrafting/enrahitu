/**
 * Role checks with any-of semantics.
 *
 * Roles are a set (string[]), never a privilege hierarchy. A caller satisfies
 * a requirement if it holds ANY of the required roles.
 */
import { APIError } from "encore.dev/api";

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
