// Types for the pre-flight verb (spec 027 §3.5). The .mjs ships as a plain node
// script the entrypoint runs before anything else exists, matching
// first-boot.mjs and gen-infra-config.mjs; the declarations live beside it so
// the test suite gets real types without the script growing a build step.

export type CheckStatus = "pass" | "warn" | "fail" | "info";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface PlannedPort {
  label: string;
  host: string;
  port: number;
}

export interface DeclaredMigrations {
  migrations?: Array<{ version: number; name: string }>;
  error?: string;
}

export interface AppliedMigrations {
  versions?: number[];
  note?: string;
  error?: string;
}

export type Env = Record<string, string | undefined>;

export declare function checkRequiredEnv(env: Env): CheckResult;
export declare function checkPublicUrl(env: Env): CheckResult;
export declare function checkDataDir(env: Env): CheckResult;
export declare function checkLedgerUrl(env: Env): CheckResult;

/** The addresses the entrypoint will bind, derived from `env`. */
export declare function plannedPorts(env: Env): PlannedPort[];
export declare function probePort(host: string, port: number): Promise<boolean>;
export declare function checkPorts(
  env: Env,
  opts?: { ports?: PlannedPort[]; probe?: (host: string, port: number) => Promise<boolean> },
): Promise<CheckResult>;

export declare function loadDeclaredMigrations(root?: string): Promise<DeclaredMigrations>;
export declare function readAppliedVersions(env: Env): Promise<AppliedMigrations>;
export declare function checkMigrations(
  env: Env,
  opts?: {
    declared?: () => Promise<DeclaredMigrations>;
    applied?: (env: Env) => Promise<AppliedMigrations>;
  },
): Promise<CheckResult>;

/** Every check, in order. `ok` is false when any check failed. */
export declare function preflight(
  env?: Env,
  opts?: {
    ports?: { ports?: PlannedPort[]; probe?: (host: string, port: number) => Promise<boolean> };
    migrations?: {
      declared?: () => Promise<DeclaredMigrations>;
      applied?: (env: Env) => Promise<AppliedMigrations>;
    };
  },
): Promise<{ ok: boolean; checks: CheckResult[] }>;

export declare function format(checks: CheckResult[]): string[];
