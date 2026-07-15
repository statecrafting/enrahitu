/**
 * CoreLedger metadata registry.
 *
 * Stage-3 decorators cannot reflect TS types (there is no
 * emitDecoratorMetadata for them), so column types are explicit in the
 * decorator options and metadata lives in this module-level registry keyed by
 * constructor, not in `Symbol.metadata` (Node support not assumed; see
 * docs/ARCHITECTURE.md decision 3).
 */

export type ColumnType =
  | "text"
  | "integer"
  | "real"
  | "blob"
  | "boolean"
  | "json"
  | "timestamp";

export interface ColumnMeta {
  /** TS property name on the entity class. */
  property: string;
  /** SQL column name (snake_case of the property unless overridden). */
  name: string;
  type: ColumnType;
  primary: boolean;
  unique: boolean;
  nullable: boolean;
  indexed: boolean;
  /** Raw SQL default expression, emitted verbatim into the DDL. */
  defaultSql?: string;
}

/** Entities must be zero-arg constructible: field initializers ARE the defaults. */
export type EntityCtor<T extends object = object> = new () => T;

export interface EntityMeta {
  table: string;
  ctor: EntityCtor;
  columns: ColumnMeta[];
  primary: ColumnMeta;
}

const byCtor = new Map<EntityCtor, EntityMeta>();

export function registerEntity(meta: EntityMeta): void {
  const existing = [...byCtor.values()].find((m) => m.table === meta.table);
  if (existing && existing.ctor !== meta.ctor) {
    throw new Error(
      `CoreLedger: table "${meta.table}" is claimed by both ${existing.ctor.name} and ${meta.ctor.name}`,
    );
  }
  byCtor.set(meta.ctor, meta);
}

export function entityMeta<T extends object>(ctor: EntityCtor<T>): EntityMeta {
  const meta = byCtor.get(ctor as EntityCtor);
  if (!meta) {
    throw new Error(
      `CoreLedger: ${ctor.name} is not a registered entity (missing @Entity decorator, or the module defining it was never imported)`,
    );
  }
  return meta;
}

export function allEntities(): EntityMeta[] {
  return [...byCtor.values()];
}
