// Types for the dependency-free generator (spec 033 §3.4). The .mjs ships as a
// plain node script a stamped app can run with nothing installed, matching
// stamp.mjs and verify-born-with.mjs; the declarations live beside it so the
// test suite and any TS consumer get real types without the script itself
// growing a build step.
export interface InfraTopology {
  /** Path, relative to the repo root, of the file this topology generates. */
  file: string;
  metadata: {
    app_id: string;
    env_name: string;
    env_type: string;
    cloud: string;
    base_url: string;
  };
  /** Whether the topology declares a `secrets` block of `$env` references. */
  secrets: boolean;
}

export declare const TOPOLOGIES: Record<string, InfraTopology>;

/** Render one topology's config file content, including the trailing newline. */
export declare function render(topology: string): string;

/** Write every topology, or (with check) report which committed files drifted. */
export declare function generate(opts?: { check?: boolean }): {
  drifted: string[];
  written: string[];
};
