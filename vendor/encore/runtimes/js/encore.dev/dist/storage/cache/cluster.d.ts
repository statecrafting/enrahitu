import * as runtime from "../../internal/runtime/mod.js";
import { StringLiteral } from "../../internal/utils/constraints.js";
/**
 * Redis eviction policy that determines how keys are evicted when memory is full.
 */
export type EvictionPolicy = "noeviction" | "allkeys-lru" | "allkeys-lfu" | "allkeys-random" | "volatile-lru" | "volatile-lfu" | "volatile-ttl" | "volatile-random";
/**
 * Configuration options for a cache cluster.
 */
export interface CacheClusterConfig {
    /**
     * The eviction policy to use when the cache is full.
     * Defaults to "allkeys-lru".
     */
    evictionPolicy?: EvictionPolicy;
}
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
export declare class CacheCluster {
    /** @internal */
    readonly impl: runtime.CacheCluster;
    /** @internal */
    readonly clusterName: string;
    /**
     * Creates a new cache cluster with the given name and configuration.
     * @param name - The unique name for this cache cluster
     * @param cfg - Optional configuration for the cluster
     */
    constructor(name: string, cfg?: CacheClusterConfig);
    /**
     * Reference an existing cache cluster by name.
     * To create a new cache cluster, use `new CacheCluster(...)` instead.
     */
    static named<Name extends string>(name: StringLiteral<Name>): CacheCluster;
}
