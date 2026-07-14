import * as runtime from "../../internal/runtime/mod.js";
/**
 * CacheCluster represents a Redis cache cluster.
 *
 * Create a new cluster using `new CacheCluster(name)`.
 * Reference an existing cluster using `CacheCluster.named(name)`.
 *
 * @example
 * ```ts
 * import { CacheCluster } from "encore.dev/storage/cache";
 *
 * const myCache = new CacheCluster("my-cache", {
 *   evictionPolicy: "allkeys-lru",
 * });
 * ```
 */
export class CacheCluster {
    /** @internal */
    impl;
    /** @internal */
    clusterName;
    /**
     * Creates a new cache cluster with the given name and configuration.
     * @param name - The unique name for this cache cluster
     * @param cfg - Optional configuration for the cluster
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(name, cfg) {
        this.clusterName = name;
        this.impl = runtime.RT.cacheCluster(name);
    }
    /**
     * Reference an existing cache cluster by name.
     * To create a new cache cluster, use `new CacheCluster(...)` instead.
     */
    static named(name) {
        return new CacheCluster(name);
    }
}
//# sourceMappingURL=cluster.js.map