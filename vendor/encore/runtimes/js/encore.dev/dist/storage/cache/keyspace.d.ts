import { CacheCluster } from "./cluster.js";
import { Expiry } from "./expiry.js";
/**
 * Configuration for a cache keyspace.
 */
export interface KeyspaceConfig<K> {
    /**
     * The pattern for generating cache keys.
     * Use `:fieldName` to include a field from the key type.
     *
     * @example
     * // For a simple key type (string, number)
     * keyPattern: "user/:id"
     *
     * // For a struct key type
     * keyPattern: "user/:userId/region/:region"
     */
    keyPattern: string;
    /**
     * Default expiry for cache entries in this keyspace.
     * If not set, entries do not expire.
     */
    defaultExpiry?: Expiry;
}
/**
 * Options for write operations.
 */
export interface WriteOptions {
    /**
     * Expiry for this specific write operation.
     * Overrides the keyspace's defaultExpiry.
     */
    expiry?: Expiry;
}
/**
 * Base class for all keyspace types (basic, list, set).
 * Provides key mapping, TTL resolution, with(), and delete().
 * @internal
 */
export declare abstract class Keyspace<K> {
    protected readonly cluster: CacheCluster;
    protected readonly config: KeyspaceConfig<K>;
    protected readonly keyMapper: (key: K) => string;
    private _effectiveExpiry?;
    constructor(cluster: CacheCluster, config: KeyspaceConfig<K>);
    /**
     * Creates a key mapper by parsing the key pattern.
     */
    private createKeyMapper;
    /**
     * Maps a key to its Redis key string.
     */
    protected mapKey(key: K): string;
    /**
     * Resolves the TTL for a write operation.
     * Returns i64 sentinel for NAPI: undefined=no config, -1=KeepTTL, -2=Persist/NeverExpire, >=0=ms
     */
    protected resolveTtl(options?: WriteOptions): number | undefined;
    /**
     * Returns a shallow clone of this keyspace with the specified write options applied.
     * This allows setting expiry for a chain of operations.
     *
     * @example
     * ```ts
     * await myKeyspace.with({ expiry: expireIn(5000) }).set(key, value);
     * ```
     */
    with(options: WriteOptions): this;
    /**
     * Deletes the specified keys.
     * If a key does not exist it is ignored.
     *
     * @returns The number of keys that were deleted.
     * @see https://redis.io/commands/del/
     */
    delete(...keys: K[]): Promise<number>;
}
