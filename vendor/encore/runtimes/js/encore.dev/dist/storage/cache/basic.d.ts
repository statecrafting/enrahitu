/// <reference types="node" />
import { CacheCluster } from "./cluster.js";
import { Keyspace, KeyspaceConfig, WriteOptions } from "./keyspace.js";
/**
 * Base class for basic (scalar value) keyspaces.
 * Provides get/set/replace/etc operations.
 * @internal
 */
declare abstract class BasicKeyspace<K, V> extends Keyspace<K> {
    constructor(cluster: CacheCluster, config: KeyspaceConfig<K>);
    /**
     * Serializes a value to a Buffer for storage.
     */
    protected abstract serialize(value: V): Buffer;
    /**
     * Deserializes a Buffer from storage to a value.
     */
    protected abstract deserialize(data: Buffer): V;
    /**
     * Gets the value stored at key.
     * If the key does not exist, it returns `undefined`.
     *
     * @returns The value, or `undefined` if the key does not exist.
     * @see https://redis.io/commands/get/
     */
    get(key: K): Promise<V | undefined>;
    /**
     * Gets the values stored at multiple keys.
     *
     * @returns An array of values in the same order as the provided keys.
     * Each element is the value or `undefined` if the key was not found.
     * @see https://redis.io/commands/mget/
     */
    multiGet(...keys: K[]): Promise<(V | undefined)[]>;
    /**
     * Updates the value stored at key to val.
     *
     * @see https://redis.io/commands/set/
     */
    set(key: K, value: V, options?: WriteOptions): Promise<void>;
    /**
     * Sets the value stored at key to val, but only if the key does not exist beforehand.
     *
     * @throws {CacheKeyExists} If the key already exists.
     * @see https://redis.io/commands/setnx/
     */
    setIfNotExists(key: K, value: V, options?: WriteOptions): Promise<void>;
    /**
     * Replaces the existing value stored at key to val.
     *
     * @throws {CacheMiss} If the key does not already exist.
     * @see https://redis.io/commands/set/
     */
    replace(key: K, value: V, options?: WriteOptions): Promise<void>;
    /**
     * Updates the value of key to val and returns the previously stored value.
     * If the key does not already exist, it sets it and returns `undefined`.
     *
     * @returns The previous value, or `undefined` if the key did not exist.
     * @see https://redis.io/commands/getset/
     */
    getAndSet(key: K, value: V, options?: WriteOptions): Promise<V | undefined>;
    /**
     * Deletes the key and returns the previously stored value.
     * If the key does not already exist, it returns `undefined`.
     *
     * @returns The previous value, or `undefined` if the key did not exist.
     * @see https://redis.io/commands/getdel/
     */
    getAndDelete(key: K): Promise<V | undefined>;
}
/**
 * StringKeyspace stores string values.
 *
 * @example
 * ```ts
 * const tokens = new StringKeyspace<string>(cluster, {
 *   keyPattern: "token/:id",
 *   defaultExpiry: ExpireIn(3600000), // 1 hour
 * });
 *
 * await tokens.set("abc123", "user-token-value");
 * const token = await tokens.get("abc123");
 * ```
 */
export declare class StringKeyspace<K> extends BasicKeyspace<K, string> {
    constructor(cluster: CacheCluster, config: KeyspaceConfig<K>);
    protected serialize(value: string): Buffer;
    protected deserialize(data: Buffer): string;
    /**
     * Appends a string to the value stored at key.
     *
     * If the key does not exist it is first created and set as the empty string,
     * causing append to behave like set.
     *
     * @returns The new string length.
     * @see https://redis.io/commands/append/
     */
    append(key: K, value: string, options?: WriteOptions): Promise<number>;
    /**
     * Returns a substring of the string value stored at key.
     *
     * The `start` and `end` values are zero-based indices, but unlike typical slicing
     * the `end` value is inclusive.
     *
     * Negative values can be used in order to provide an offset starting
     * from the end of the string, so -1 means the last character.
     *
     * If the string does not exist it returns the empty string.
     *
     * @param key - The cache key.
     * @param start - Start index (inclusive, 0-based).
     * @param end - End index (inclusive, 0-based). Use -1 for end of string.
     * @returns The substring.
     * @see https://redis.io/commands/getrange/
     */
    getRange(key: K, start: number, end: number): Promise<string>;
    /**
     * Overwrites part of the string stored at key, starting at
     * the zero-based `offset` and for the entire length of `value`, extending
     * the string if necessary.
     *
     * If the offset is larger than the current string length stored at key,
     * the string is first padded with zero-bytes to make offset fit.
     *
     * Non-existing keys are considered as empty strings.
     *
     * @param key - The cache key.
     * @param offset - Zero-based byte offset to start writing at.
     * @param value - The string to write.
     * @returns The length of the string after the operation.
     * @see https://redis.io/commands/setrange/
     */
    setRange(key: K, offset: number, value: string, options?: WriteOptions): Promise<number>;
    /**
     * Returns the length of the string value stored at key.
     *
     * Non-existing keys are considered as empty strings.
     *
     * @returns The string length.
     * @see https://redis.io/commands/strlen/
     */
    len(key: K): Promise<number>;
}
/**
 * IntKeyspace stores 64-bit integer values.
 * Values are floored to integers using `Math.floor`.
 * For fractional values, use {@link FloatKeyspace} instead.
 *
 * @example
 * ```ts
 * const counters = new IntKeyspace<string>(cluster, {
 *   keyPattern: "counter/:name",
 * });
 *
 * await counters.set("page-views", 0);
 * const newCount = await counters.increment("page-views", 1);
 * ```
 */
export declare class IntKeyspace<K> extends BasicKeyspace<K, number> {
    constructor(cluster: CacheCluster, config: KeyspaceConfig<K>);
    protected serialize(value: number): Buffer;
    protected deserialize(data: Buffer): number;
    /**
     * Increments the number stored at key by `delta`.
     *
     * If the key does not exist it is first created with a value of 0
     * before incrementing.
     *
     * Negative values can be used to decrease the value,
     * but typically you want to use {@link decrement} for that.
     *
     * @param key - The cache key.
     * @param delta - The amount to increment by (default 1).
     * @returns The new value after incrementing.
     * @see https://redis.io/commands/incrby/
     */
    increment(key: K, delta?: number, options?: WriteOptions): Promise<number>;
    /**
     * Decrements the number stored at key by `delta`.
     *
     * If the key does not exist it is first created with a value of 0
     * before decrementing.
     *
     * Negative values can be used to increase the value,
     * but typically you want to use {@link increment} for that.
     *
     * @param key - The cache key.
     * @param delta - The amount to decrement by (default 1).
     * @returns The new value after decrementing.
     * @see https://redis.io/commands/decrby/
     */
    decrement(key: K, delta?: number, options?: WriteOptions): Promise<number>;
}
/**
 * FloatKeyspace stores 64-bit floating point values.
 *
 * @example
 * ```ts
 * const scores = new FloatKeyspace<string>(cluster, {
 *   keyPattern: "score/:playerId",
 * });
 *
 * await scores.set("player1", 100.5);
 * const newScore = await scores.increment("player1", 10.25);
 * ```
 */
export declare class FloatKeyspace<K> extends BasicKeyspace<K, number> {
    constructor(cluster: CacheCluster, config: KeyspaceConfig<K>);
    protected serialize(value: number): Buffer;
    protected deserialize(data: Buffer): number;
    /**
     * Increments the number stored at key by `delta`.
     *
     * If the key does not exist it is first created with a value of 0
     * before incrementing.
     *
     * Negative values can be used to decrease the value,
     * but typically you want to use {@link decrement} for that.
     *
     * @param key - The cache key.
     * @param delta - The amount to increment by (default 1).
     * @returns The new value after incrementing.
     * @see https://redis.io/commands/incrbyfloat/
     */
    increment(key: K, delta?: number, options?: WriteOptions): Promise<number>;
    /**
     * Decrements the number stored at key by `delta`.
     *
     * If the key does not exist it is first created with a value of 0
     * before decrementing.
     *
     * Negative values can be used to increase the value,
     * but typically you want to use {@link increment} for that.
     *
     * @param key - The cache key.
     * @param delta - The amount to decrement by (default 1).
     * @returns The new value after decrementing.
     * @see https://redis.io/commands/incrbyfloat/
     */
    decrement(key: K, delta?: number, options?: WriteOptions): Promise<number>;
}
/**
 * StructKeyspace stores arbitrary objects serialized as JSON.
 *
 * @example
 * ```ts
 * interface User {
 *   id: string;
 *   name: string;
 *   email: string;
 * }
 *
 * const users = new StructKeyspace<string, User>(cluster, {
 *   keyPattern: "user/:id",
 *   defaultExpiry: ExpireIn(3600000),
 * });
 *
 * await users.set("user1", { id: "user1", name: "Alice", email: "alice@example.com" });
 * const user = await users.get("user1");
 * ```
 */
export declare class StructKeyspace<K, V> extends BasicKeyspace<K, V> {
    constructor(cluster: CacheCluster, config: KeyspaceConfig<K>);
    protected serialize(value: V): Buffer;
    protected deserialize(data: Buffer): V;
}
export {};
