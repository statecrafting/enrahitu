export interface UsageTouch {
  kind?: string;
  resource?: string;
  family?: string;
  via: string;
}
export interface GrantLike {
  kind: string;
  resource: string;
}
export declare function observeService(repoRoot: string, serviceDir: string): UsageTouch[];
export declare function covered(
  touch: { kind?: string; resource?: string; family?: string },
  grants: GrantLike[],
): boolean;
export declare function banViolations(repoRoot: string): string[];
