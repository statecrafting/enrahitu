/**
 * The kind registry (spec 034 §3.2): what a resource type is, and what makes
 * one admissible.
 *
 * A kind is deliberately small. It is a name, a tenancy decision, and a
 * validator. It is not a schema language, not an ORM mapping, and not a
 * migration: the store holds `spec` as JSON and the validator is the only thing
 * that says what that JSON may be. That keeps the association domain (phase 5)
 * additive, because adding a resource type is registering a kind rather than
 * changing the schema.
 *
 * The validator returns the normalized value rather than a boolean. A predicate
 * would let a caller admit the unnormalized input it was handed, which is the
 * usual way a "validated" record ends up holding whitespace, a stringified
 * number, or a field nobody declared.
 */

/** Thrown when a spec fails its kind's validator. Carries the field, not just a message. */
export class InvalidSpecError extends Error {
  constructor(
    readonly kind: string,
    readonly field: string,
    message: string,
  ) {
    super(`invalid ${kind}: ${field}: ${message}`);
    this.name = "InvalidSpecError";
  }
}

export interface Kind<TSpec> {
  /** The resource type name, also the notify routing key (spec 032 §3.2). */
  readonly name: string;
  /**
   * Whether resources of this kind belong to a tenant.
   *
   * Cluster-scoped kinds store `''` as their tenant. That is a real decision
   * rather than a default: the primary key includes tenant, and SQLite does not
   * treat NULLs as equal, so a nullable tenant would admit duplicate rows for
   * the same cluster-scoped resource.
   */
  readonly tenantScoped: boolean;
  /** Validate and normalize. Throws `InvalidSpecError` naming the offending field. */
  validate(input: unknown): TSpec;
}

const registry = new Map<string, Kind<unknown>>();

/**
 * Register a kind. Idempotent for the identical registration, and a refusal for
 * a conflicting one.
 *
 * The refusal matters more than it looks: two modules registering the same name
 * with different validators would make admissibility depend on module load
 * order, and the resulting bug appears as data that was valid on Tuesday.
 */
export function registerKind<TSpec>(kind: Kind<TSpec>): Kind<TSpec> {
  const existing = registry.get(kind.name);
  if (existing && existing !== (kind as Kind<unknown>)) {
    throw new Error(
      `kind '${kind.name}' is already registered with a different definition`,
    );
  }
  registry.set(kind.name, kind as Kind<unknown>);
  return kind;
}

/** Look up a registered kind, or throw naming what is registered. */
export function requireKind(name: string): Kind<unknown> {
  const found = registry.get(name);
  if (!found) {
    const known = [...registry.keys()].sort().join(", ") || "<none>";
    throw new Error(`unknown kind '${name}'; registered: ${known}`);
  }
  return found;
}

/** Every registered kind name, sorted. The admin catalog reads this. */
export function registeredKinds(): string[] {
  return [...registry.keys()].sort();
}

/** Test seam: drop every registration. Never called by runtime code. */
export function resetKindsForTest(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// Validator helpers
//
// Small on purpose. A kind's validator is ordinary code, and these exist so the
// common shapes do not each grow their own idea of what "required string" means.
// ---------------------------------------------------------------------------

export function requireString(kind: string, obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== "string") {
    throw new InvalidSpecError(kind, field, `expected a string, got ${typeof value}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new InvalidSpecError(kind, field, "must not be empty");
  return trimmed;
}

export function optionalString(
  kind: string,
  obj: Record<string, unknown>,
  field: string,
): string | undefined {
  if (obj[field] === undefined || obj[field] === null) return undefined;
  return requireString(kind, obj, field);
}

export function requireObject(kind: string, input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InvalidSpecError(kind, "<root>", "expected an object");
  }
  return input as Record<string, unknown>;
}

export function requireEnum<T extends string>(
  kind: string,
  obj: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = requireString(kind, obj, field);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new InvalidSpecError(kind, field, `expected one of ${allowed.join(", ")}, got '${value}'`);
  }
  return value as T;
}
