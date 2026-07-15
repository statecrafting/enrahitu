export function platformPackage(platform?: string, arch?: string): string | null;

export function resolveBinary(opts?: {
  binary: string;
  envOverride?: string;
  cwd?: string;
  platform?: string;
  arch?: string;
}): string | null;

export function runtimeLib(opts?: {
  envOverride?: string;
  cwd?: string;
  platform?: string;
  arch?: string;
}): string | null;

export function tsparserBin(opts?: {
  envOverride?: string;
  cwd?: string;
  platform?: string;
  arch?: string;
}): string | null;
