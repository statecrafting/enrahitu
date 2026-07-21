export interface PathSegmentLike {
  type: string;
  value: string;
}
export declare function decodeMeta(metaPath: string): Promise<Record<string, unknown> & {
  svcs: Array<Record<string, unknown>>;
  pkgs: Array<Record<string, unknown>>;
}>;
export declare function pathString(path: { segments?: PathSegmentLike[] } | undefined): string;
export declare function accessString(rpc: { accessType?: string }): string;
