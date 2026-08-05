/**
 * What a schema apply would do, as a pure function.
 *
 * Its own module because `schema.ts` reaches `~encore/auth` through the operator
 * gate, and that binding only exists inside an Encore build. The decision an
 * operator is about to take should be assertable in an ordinary test, so it
 * lives where an ordinary test can reach it.
 */
export interface MigrationSummary {
  version: number;
  name: string;
}

/**
 * The migrations above the applied high-water mark.
 *
 * Comparing against the highest applied version is exact rather than
 * approximate: the runner refuses a list whose versions do not ascend and
 * refuses duplicates (spec 032 §3.6), so nothing can sit below the mark
 * unapplied. CoreLedger's runner refuses the same two things (spec 011), which
 * is why one function serves both stores: this takes the summary shape both
 * migration types already satisfy rather than either store's own type, so
 * neither store's list can drift into the other's plan.
 */
export function pendingMigrations(version: number, all: MigrationSummary[]): MigrationSummary[] {
  return all
    .filter((m) => m.version > version)
    .map((m) => ({ version: m.version, name: m.name }));
}
