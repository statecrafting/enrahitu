/**
 * The placeholder-order guard (spec 032, implementation record).
 *
 * hiqlite binds parameters to placeholders **in order of first appearance, and
 * ignores the number**. `$1` and `$2` therefore look like numbered binding and
 * behave like positional binding, so a statement whose numbers are not
 * ascending by first appearance binds the wrong values:
 *
 * ```sql
 * -- params: ["A", "B"]
 * SELECT * FROM t WHERE b = $2 AND a = $1   -- binds b := "A", a := "B"
 * ```
 *
 * There is no error and no warning. The query returns the wrong rows, an
 * UPDATE reports zero rows affected, and an `INSERT ... SELECT` inserts
 * nothing. It cost two silently-empty tables and a tombstone that never
 * appeared before the behavior was isolated, and none of the three looked like
 * a binding problem from the failure alone.
 *
 * So every statement crossing this facade is checked. The rule is exactly what
 * the store requires: the first occurrence of each distinct placeholder must be
 * numbered 1, 2, 3, ... in the order it appears. Re-using an already-seen
 * number later in the statement is fine and is the normal way to use one value
 * twice.
 *
 * The scanner skips single-quoted string literals so a `'costs $5'` cannot be
 * read as a placeholder, and handles SQL's doubled-quote escape.
 */

/** Thrown when a statement's placeholders would bind to the wrong parameters. */
export class PlaceholderOrderError extends Error {
  constructor(
    readonly sql: string,
    readonly found: number,
    readonly expected: number,
  ) {
    super(
      `placeholder $${found} appears where $${expected} is required: hiqlite binds parameters ` +
        `in order of first appearance and ignores the number, so this statement would bind the ` +
        `wrong values silently. Renumber so each placeholder's first occurrence ascends ` +
        `1, 2, 3, ... (re-using an earlier number later is fine). Statement: ${sql}`,
    );
    this.name = "PlaceholderOrderError";
  }
}

/**
 * Throw unless `sql`'s placeholders ascend by first appearance.
 *
 * Returns the number of distinct placeholders, which is what a caller's
 * parameter array must be long enough to cover.
 */
export function assertPlaceholderOrder(sql: string): number {
  const seen = new Set<number>();
  let next = 1;
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      // '' is an escaped quote inside a literal, not the end of one.
      if (ch === "'") {
        if (sql[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch !== "$") continue;

    let j = i + 1;
    while (j < sql.length && sql[j]! >= "0" && sql[j]! <= "9") j++;
    if (j === i + 1) continue; // a bare $, not a placeholder
    const num = Number(sql.slice(i + 1, j));
    i = j - 1;

    if (seen.has(num)) continue; // a legitimate re-use of an earlier value
    if (num !== next) throw new PlaceholderOrderError(sql, num, next);
    seen.add(num);
    next++;
  }
  return seen.size;
}
