// Types for the dependency-free manifest composer (spec 035 §3.3). The .mjs
// ships as a plain node script a stamped app can run with nothing installed,
// matching gen-infra-config.mjs and stamp.mjs; the declarations live beside it
// so the test suite gets real types without the script growing a build step.

export interface CapabilityDecl {
  id: string;
  kind: string;
  resource: string;
  constraints?: Record<string, unknown>;
}

export interface ServiceDecl {
  tier?: string;
  role?: string;
  capabilities?: string[];
}

export interface Manifest {
  capabilities: CapabilityDecl[];
  services: Record<string, ServiceDecl>;
  resources: Record<string, Array<{ name: string; [k: string]: unknown }>>;
  [k: string]: unknown;
}

/**
 * Merge an organization's overlay onto the chassis manifest.
 *
 * Additive only: a collision with a chassis capability, resource, or any
 * non-capability field of a chassis service is refused (the process exits
 * nonzero with a message naming the collision), because precedence would widen
 * a ceiling invisibly. The one exception is additive grants to a chassis
 * service.
 */
export declare function compose(chassis: Manifest, overlay: Partial<Manifest>): Manifest;
