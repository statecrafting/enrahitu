// Types for the restore verb (spec 027 §3.3).

import type { CellState, Env, Manifest } from "./archive.d.mts";

export interface RestoreOptions {
  /** The archive to restore. */
  from?: string;
  /** Injected liveness, so a test can put the verb on either side of it. */
  cell?: CellState;
}

export declare function verifyMembers(
  dir: string,
  manifest: Pick<Manifest, "files"> & Partial<Manifest>,
): Promise<string[]>;

/** Is this member a hiqlite snapshot file, or a raft directory? */
export declare function memberShape(
  dir: string,
  member: string,
): "absent" | "snapshot" | "directory";

export declare function restore(
  env?: Env,
  opts?: RestoreOptions,
): Promise<{ manifest: Manifest; applied: string[]; warnings: string[] }>;
