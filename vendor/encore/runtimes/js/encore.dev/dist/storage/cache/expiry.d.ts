/**
 * Expiry represents a cache key expiration configuration.
 * Use the helper functions to create expiry configurations.
 */
export type Expiry = {
    type: "duration";
    durationMs: number;
} | {
    type: "time";
    hours: number;
    minutes: number;
    seconds: number;
} | "never" | "keep-ttl";
/**
 * expireIn sets the cache entry to expire after the specified duration.
 * @param ms - Duration in milliseconds
 */
export declare function expireIn(ms: number): Expiry;
/**
 * expireInSeconds sets the cache entry to expire after the specified seconds.
 * @param seconds - Duration in seconds
 */
export declare function expireInSeconds(seconds: number): Expiry;
/**
 * expireInMinutes sets the cache entry to expire after the specified minutes.
 * @param minutes - Duration in minutes
 */
export declare function expireInMinutes(minutes: number): Expiry;
/**
 * expireInHours sets the cache entry to expire after the specified hours.
 * @param hours - Duration in hours
 */
export declare function expireInHours(hours: number): Expiry;
/**
 * expireDailyAt sets the cache entry to expire at a specific time each day (UTC).
 * @param hours - Hour (0-23)
 * @param minutes - Minutes (0-59)
 * @param seconds - Seconds (0-59)
 */
export declare function expireDailyAt(hours: number, minutes: number, seconds: number): Expiry;
/**
 * neverExpire sets the cache entry to never expire.
 * Note: Redis may still evict the key based on the eviction policy.
 */
export declare const neverExpire: Expiry;
/**
 * keepTTL preserves the existing TTL when updating a cache entry.
 * If the key doesn't exist, no TTL is set.
 */
export declare const keepTTL: Expiry;
/**
 * Resolves an Expiry to a duration in milliseconds, "never", or "keep-ttl".
 * @internal
 */
export declare function resolveExpiry(expiry: Expiry): number | "never" | "keep-ttl";
