/**
 * CoreLedger decorators (stage-3 / TC39, NOT experimentalDecorators).
 *
 * Field decorators run at class-definition time, before the class decorator,
 * so @Column pushes into a module-level pending buffer that @Entity flushes.
 * JS module evaluation is single-threaded and a class definition cannot
 * interleave with another, so the buffer is safe.
 */

import type { ColumnMeta, ColumnType, EntityCtor } from "./metadata";
import { registerEntity } from "./metadata";

export interface ColumnOptions {
  /** SQL storage type; defaults to "text". */
  type?: ColumnType;
  /** Override the SQL column name (default: snake_case of the property). */
  name?: string;
  primary?: boolean;
  unique?: boolean;
  nullable?: boolean;
  /** Create a plain (non-unique) index on this column. */
  index?: boolean;
  /** Raw SQL default expression, emitted verbatim into the DDL. */
  defaultSql?: string;
}

function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

let pending: ColumnMeta[] = [];

export function Column(options: ColumnOptions = {}) {
  return function (_value: undefined, context: ClassFieldDecoratorContext): void {
    if (context.static) {
      throw new Error("CoreLedger: @Column cannot decorate static fields");
    }
    if (typeof context.name === "symbol") {
      throw new Error("CoreLedger: @Column cannot decorate symbol-named fields");
    }
    pending.push({
      property: context.name,
      name: options.name ?? snakeCase(context.name),
      type: options.type ?? "text",
      primary: options.primary ?? false,
      unique: options.unique ?? false,
      nullable: options.nullable ?? false,
      indexed: options.index ?? false,
      defaultSql: options.defaultSql,
    });
  };
}

export function Entity(table: string) {
  return function (target: EntityCtor, _context: ClassDecoratorContext): void {
    const columns = pending;
    pending = [];
    if (columns.length === 0) {
      throw new Error(`CoreLedger: @Entity("${table}") has no @Column fields`);
    }
    const duplicates = columns
      .map((c) => c.name)
      .filter((name, i, all) => all.indexOf(name) !== i);
    if (duplicates.length > 0) {
      throw new Error(
        `CoreLedger: @Entity("${table}") has duplicate column names: ${duplicates.join(", ")}`,
      );
    }
    const primaries = columns.filter((c) => c.primary);
    if (primaries.length !== 1) {
      throw new Error(
        `CoreLedger: @Entity("${table}") needs exactly one primary @Column, found ${primaries.length}`,
      );
    }
    registerEntity({ table, ctor: target, columns, primary: primaries[0] });
  };
}
