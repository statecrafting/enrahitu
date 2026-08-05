// Types for the archive primitives the backup and restore verbs share
// (spec 027 §3.1-§3.3). The .mjs ships as a plain node script that runs in the
// packaged image with production dependencies only, matching preflight.mjs and
// first-boot.mjs; the declarations live beside it so the test suite gets real
// types without the script growing a build step.

export type Env = Record<string, string | undefined>;

export interface ManifestFile {
  path: string;
  sha256: string;
}

export interface ManifestMember {
  /** One of the four state classes: ledger, state, rauthy, keys. */
  name: string;
  capturedAt: string;
  /** A digest over this member's sorted (path, sha256) pairs. */
  sha256?: string;
  files?: string[];
  note?: string;
}

export interface Manifest {
  template: { name: string | null; version: string | null; contract: string | null };
  /** Read out of the chain in the archive, not off the running image. */
  modelHash: string | null;
  gateConfigHash: string | null;
  ledgerUrlScheme: string | null;
  mode: "cold" | "hot";
  createdAt: string;
  members: ManifestMember[];
  files: ManifestFile[];
  notes: string[];
}

export interface CellState {
  running: boolean;
  host: string;
  port: number;
}

export declare const MEMBERS: Record<string, string>;
export declare const MANIFEST: string;
export declare const DEFAULT_DATA_DIR: string;

export declare function sha256File(path: string): Promise<string>;
export declare function assertPrivateDirectory(dir: string): void;
export declare function cellIsRunning(env?: Env): Promise<CellState>;
export declare function writeArchive(stageDir: string, destination: string): void;
export declare function extractArchive(archive: string, into: string): void;
export declare function listArchive(archive: string): string[];
export declare function writeManifest(stageDir: string, manifest: Manifest): Promise<void>;
export declare function readManifest(dir: string): Promise<Manifest>;
export declare function chainHashes(
  client: unknown,
): Promise<{ modelHash: string | null; gateConfigHash: string | null }>;
export declare function ledgerScheme(raw: string): string | null;
export declare function ledgerIsLocal(raw: string): boolean;
