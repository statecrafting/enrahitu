import { getCurrentRequest } from "../../internal/reqtrack/mod.js";
import { resolveExpiry } from "./expiry.js";
/**
 * Base class for all keyspace types (basic, list, set).
 * Provides key mapping, TTL resolution, with(), and delete().
 * @internal
 */
export class Keyspace {
    cluster;
    config;
    keyMapper;
    _effectiveExpiry;
    constructor(cluster, config) {
        this.cluster = cluster;
        this.config = config;
        this.keyMapper = this.createKeyMapper(config.keyPattern);
    }
    /**
     * Creates a key mapper by parsing the key pattern.
     */
    createKeyMapper(pattern) {
        const segments = pattern.split("/").map((seg) => {
            if (seg.startsWith(":")) {
                return { isLiteral: false, value: seg.slice(1), field: seg.slice(1) };
            }
            return { isLiteral: true, value: seg };
        });
        return (key) => {
            return segments
                .map((seg) => {
                if (seg.isLiteral)
                    return seg.value;
                let val;
                if (typeof key === "object" && key !== null && seg.field) {
                    val = key[seg.field];
                }
                else {
                    val = key;
                }
                // Escape forward slashes in string values
                const str = String(val);
                return str.replace(/\//g, "\\/");
            })
                .join("/");
        };
    }
    /**
     * Maps a key to its Redis key string.
     */
    mapKey(key) {
        const mapped = this.keyMapper(key);
        if (mapped.startsWith("__encore")) {
            throw new Error('use of reserved key prefix "__encore"');
        }
        return mapped;
    }
    /**
     * Resolves the TTL for a write operation.
     * Returns i64 sentinel for NAPI: undefined=no config, -1=KeepTTL, -2=Persist/NeverExpire, >=0=ms
     */
    resolveTtl(options) {
        const expiry = options?.expiry ?? this._effectiveExpiry ?? this.config.defaultExpiry;
        if (!expiry)
            return undefined;
        const resolved = resolveExpiry(expiry);
        if (resolved === "keep-ttl")
            return -1; // KeepTTL
        if (resolved === "never")
            return -2; // NeverExpire → Persist
        return resolved; // milliseconds
    }
    /**
     * Returns a shallow clone of this keyspace with the specified write options applied.
     * This allows setting expiry for a chain of operations.
     *
     * @example
     * ```ts
     * await myKeyspace.with({ expiry: expireIn(5000) }).set(key, value);
     * ```
     */
    with(options) {
        const clone = Object.create(Object.getPrototypeOf(this));
        Object.assign(clone, this);
        clone._effectiveExpiry = options.expiry ?? this._effectiveExpiry;
        return clone;
    }
    /**
     * Deletes the specified keys.
     * If a key does not exist it is ignored.
     *
     * @returns The number of keys that were deleted.
     * @see https://redis.io/commands/del/
     */
    async delete(...keys) {
        const source = getCurrentRequest();
        const mappedKeys = keys.map((k) => this.mapKey(k));
        return await this.cluster.impl.delete(mappedKeys, source);
    }
}
//# sourceMappingURL=keyspace.js.map