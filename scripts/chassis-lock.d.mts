// Types for the dependency-free chassis lock (spec 035 §3.2). Plain node, no
// build step, declarations beside it: same arrangement as gen-infra-config.

/** A sha256 per chassis file, keyed by repo-relative POSIX path. */
export interface ChassisLock {
  version: number;
  files: Record<string, string>;
}

/** What an upgrade would do to each locked file. */
export interface Classification {
  /** Count of files the upgrade replaces silently, losing nothing. */
  unmodified: number;
  /** Chassis files edited locally: an upgrade would discard these. */
  modified: string[];
  /** Chassis files deleted locally: same treatment as modified. */
  removed: string[];
  /**
   * Files present in a chassis root but absent from the lock. Reported, not a
   * hazard: they are the organization's until the chassis ships one at the same
   * path, and that collision surfaces as `modified` on the next lock.
   */
  added: string[];
}

export declare function classify(lock: ChassisLock, current: ChassisLock): Classification;
