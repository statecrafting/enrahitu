/// <reference types="node" />
import { CacheCluster } from "./cluster.js";
import { Keyspace, KeyspaceConfig, WriteOptions } from "./keyspace.js";
/**
 * Base class for set keyspaces with all set operations.
 * Subclasses provide typed serialization/deserialization.
 * @internal
 */
declare abstract class SetKeyspace<K, V> extends Keyspace<K> {
    constructor(cluster: CacheCluster, config: KeyspaceConfig<K>);
    protected abstract serializeItem(value: V): Buffer;
    protected abstract deserializeItem(data: Buffer): V;
    /**
     * Adds one or more values to the set stored at key.
     * If the key does not already exist, it is first created as an empty set.
     *
     * @returns The number of values that were added to the set,
     * not including values already present beforehand.
     * @see https://redis.io/commands/sadd/
     */
    add(key: K, ...members: V[]): Promise<number>;
    /**
     * Removes one or more values from the set stored at key.
     * Values not present in the set are ignored.
     * If the key does not already exist, it is a no-op.
     *
     * @returns The number of values that were removed from the set.
     * @see https://redis.io/commands/srem/
     */
    remove(key: K, ...members: V[]): Promise<number>;
    /**
     * Removes a random element from the set stored at key and returns it.
     *
     * @returns The removed member, or `undefined` if the set is empty.
     * @see https://redis.io/commands/spop/
     */
    popOne(key: K, options?: WriteOptions): Promise<V | undefined>;
    /**
     * Removes up to `count` random elements (bounded by the set's size)
     * from the set stored at key and returns them.
     *
     * If the set is empty it returns an empty array.
     *
     * @param key - The cache key.
     * @param count - Number of members to pop.
     * @returns The removed members (may be fewer than `count` if the set is small).
     * @see https://redis.io/commands/spop/
     */
    pop(key: K, count: number, options?: WriteOptions): Promise<V[]>;
    /**
     * Reports whether the set stored at key contains the given value.
     *
     * If the key does not exist it returns `false`.
     *
     * @returns `true` if the member exists in the set, `false` otherwise.
     * @see https://redis.io/commands/sismember/
     */
    contains(key: K, member: V): Promise<boolean>;
    /**
     * Returns the number of elements in the set stored at key.
     *
     * If the key does not exist it returns 0.
     *
     * @returns The set cardinality.
     * @see https://redis.io/commands/scard/
     */
    len(key: K): Promise<number>;
    /**
     * Returns the elements in the set stored at key.
     *
     * If the key does not exist it returns an empty array.
     *
     * @returns All members of the set.
     * @see https://redis.io/commands/smembers/
     */
    items(key: K): Promise<V[]>;
    /**
     * Identical to {@link items} except it returns the values as a `Set`.
     *
     * If the key does not exist it returns an empty `Set`.
     *
     * @returns All members of the set as a `Set`.
     * @see https://redis.io/commands/smembers/
     */
    itemsSet(key: K): Promise<Set<V>>;
    /**
     * Computes the set difference between the first set and all the consecutive sets.
     *
     * Set difference means the values present in the first set that are not present
     * in any of the other sets.
     *
     * Keys that do not exist are considered as empty sets.
     *
     * @param keys - Keys of sets to compute difference for. At least one must be provided.
     * @returns Members in the first set but not in any of the other sets.
     * @throws {Error} If no keys are provided.
     * @see https://redis.io/commands/sdiff/
     */
    diff(...keys: K[]): Promise<V[]>;
    /**
     * Identical to {@link diff} except it returns the values as a `Set`.
     *
     * @see https://redis.io/commands/sdiff/
     */
    diffSet(...keys: K[]): Promise<Set<V>>;
    /**
     * Computes the set difference between keys (like {@link diff}) and stores the result
     * in `destination`.
     *
     * @param destination - Key to store the result.
     * @param keys - Keys of sets to compute difference for.
     * @returns The size of the resulting set.
     * @see https://redis.io/commands/sdiffstore/
     */
    diffStore(destination: K, ...keys: K[]): Promise<number>;
    /**
     * Computes the set intersection between the sets stored at the given keys.
     *
     * Set intersection means the values common to all the provided sets.
     *
     * Keys that do not exist are considered to be empty sets.
     * As a result, if any key is missing the final result is the empty set.
     *
     * @param keys - Keys of sets to compute intersection for. At least one must be provided.
     * @returns Members common to all sets.
     * @throws {Error} If no keys are provided.
     * @see https://redis.io/commands/sinter/
     */
    intersect(...keys: K[]): Promise<V[]>;
    /**
     * Identical to {@link intersect} except it returns the values as a `Set`.
     *
     * @see https://redis.io/commands/sinter/
     */
    intersectSet(...keys: K[]): Promise<Set<V>>;
    /**
     * Computes the set intersection between keys (like {@link intersect}) and stores the result
     * in `destination`.
     *
     * @param destination - Key to store the result.
     * @param keys - Keys of sets to compute intersection for.
     * @returns The size of the resulting set.
     * @see https://redis.io/commands/sinterstore/
     */
    intersectStore(destination: K, ...keys: K[]): Promise<number>;
    /**
     * Computes the set union between the sets stored at the given keys.
     *
     * Set union means the values present in at least one of the provided sets.
     *
     * Keys that do not exist are considered to be empty sets.
     *
     * @param keys - Keys of sets to compute union for. At least one must be provided.
     * @returns Members in any of the provided sets.
     * @throws {Error} If no keys are provided.
     * @see https://redis.io/commands/sunion/
     */
    union(...keys: K[]): Promise<V[]>;
    /**
     * Identical to {@link union} except it returns the values as a `Set`.
     *
     * @see https://redis.io/commands/sunion/
     */
    unionSet(...keys: K[]): Promise<Set<V>>;
    /**
     * Computes the set union between sets (like {@link union}) and stores the result
     * in `destination`.
     *
     * @param destination - Key to store the result.
     * @param keys - Keys of sets to compute union for.
     * @returns The size of the resulting set.
     * @see https://redis.io/commands/sunionstore/
     */
    unionStore(destination: K, ...keys: K[]): Promise<number>;
    /**
     * Returns a random member from the set stored at key without removing it.
     *
     * @returns A random member, or `undefined` if the key does not exist.
     * @see https://redis.io/commands/srandmember/
     */
    sampleOne(key: K): Promise<V | undefined>;
    /**
     * Returns up to `count` distinct random elements from the set stored at key.
     * The same element is never returned multiple times.
     *
     * If the key does not exist it returns an empty array.
     *
     * @param key - The cache key.
     * @param count - Number of distinct members to return.
     * @returns Random members (may be fewer than `count` if the set is small).
     * @see https://redis.io/commands/srandmember/
     */
    sample(key: K, count: number): Promise<V[]>;
    /**
     * Returns `count` random elements from the set stored at key.
     * The same element may be returned multiple times.
     *
     * If the key does not exist it returns an empty array.
     *
     * @param key - The cache key.
     * @param count - Number of members to return (may include duplicates).
     * @returns Random members, possibly with duplicates.
     * @see https://redis.io/commands/srandmember/
     */
    sampleWithReplacement(key: K, count: number): Promise<V[]>;
    /**
     * Atomically moves the given member from the set stored at `src`
     * to the set stored at `dst`.
     *
     * If the element already exists in `dst` it is still removed from `src`.
     *
     * @param src - Source set key.
     * @param dst - Destination set key.
     * @param member - The member to move.
     * @returns `true` if the member was moved, `false` if not found in `src`.
     * @see https://redis.io/commands/smove/
     */
    move(src: K, dst: K, member: V, options?: WriteOptions): Promise<boolean>;
}
/**
 * StringSetKeyspace stores sets of unique string values.
 *
 * @example
 * ```ts
 * const tags = new StringSetKeyspace<string>(cluster, {
 *   keyPattern: "tags/:articleId",
 * });
 *
 * await tags.add("article1", "typescript", "programming", "web");
 * const hasTech = await tags.contains("article1", "typescript");
 * const allTags = await tags.items("article1");
 * const tagSet = await tags.itemsSet("article1");
 * ```
 */
export declare class StringSetKeyspace<K> extends SetKeyspace<K, string> {
    constructor(cluster: CacheCluster, config: KeyspaceConfig<K>);
    protected serializeItem(value: string): Buffer;
    protected deserializeItem(data: Buffer): string;
}
/**
 * NumberSetKeyspace stores sets of unique numeric values.
 *
 * @example
 * ```ts
 * const scores = new NumberSetKeyspace<string>(cluster, {
 *   keyPattern: "unique-scores/:gameId",
 * });
 *
 * await scores.add("game1", 100, 200, 300);
 * const hasScore = await scores.contains("game1", 100);
 * ```
 */
export declare class NumberSetKeyspace<K> extends SetKeyspace<K, number> {
    constructor(cluster: CacheCluster, config: KeyspaceConfig<K>);
    protected serializeItem(value: number): Buffer;
    protected deserializeItem(data: Buffer): number;
}
export {};
