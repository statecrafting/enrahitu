// Types for the migrate verb (spec 027 §3.4). The verb owns no migration
// logic: it is the transport over the admin plane's two schema pairs.

import type { Env } from "./archive.d.mts";

export interface MigrationSummary {
  version: number;
  name: string;
}

export interface Store {
  key: "state" | "ledger";
  label: string;
  read: string;
  apply: string;
}

export interface PlannedStore extends Store {
  version: number;
  pending: MigrationSummary[];
}

export interface AppliedStore extends Store {
  version: number;
  applied: number[];
  /** Present when another runner recorded a version mid-flight. */
  concurrent?: string;
}

export interface MigrateOptions {
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

export declare const STORES: Store[];
export declare function plan(env?: Env, opts?: MigrateOptions): Promise<PlannedStore[]>;
export declare function apply(env?: Env, opts?: MigrateOptions): Promise<AppliedStore[]>;
