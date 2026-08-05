// Types for the backup verb (spec 027 §3.2).

import type { CellState, Env, Manifest } from "./archive.d.mts";

export interface BackupOptions {
  /** Hot mode. Cold is the default, and is defined by a stopped container. */
  online?: boolean;
  /** Directory the archive is written into; refused if others can read it. */
  out?: string;
  /** An explicit destination path, overriding the generated name. */
  destination?: string;
  /** Injected liveness, so a test can put the verb on either side of it. */
  cell?: CellState;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface CapturedMember {
  path?: string;
  capturedAt?: string;
  note?: string;
  error?: string;
}

export interface CapturedLedger extends CapturedMember {
  modelHash: string | null;
  gateConfigHash: string | null;
  scheme: string | null;
}

export declare function captureState(env: Env, opts?: BackupOptions): Promise<CapturedMember>;
export declare function captureRauthy(env: Env, opts?: BackupOptions): Promise<CapturedMember>;
export declare function captureLedger(env: Env, stageDir: string): Promise<CapturedLedger>;

export declare function backup(
  env?: Env,
  opts?: BackupOptions,
): Promise<{ destination: string; manifest: Manifest }>;
