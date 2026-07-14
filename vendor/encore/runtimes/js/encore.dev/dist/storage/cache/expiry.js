/**
 * expireIn sets the cache entry to expire after the specified duration.
 * @param ms - Duration in milliseconds
 */
export function expireIn(ms) {
    return { type: "duration", durationMs: ms };
}
/**
 * expireInSeconds sets the cache entry to expire after the specified seconds.
 * @param seconds - Duration in seconds
 */
export function expireInSeconds(seconds) {
    return { type: "duration", durationMs: seconds * 1000 };
}
/**
 * expireInMinutes sets the cache entry to expire after the specified minutes.
 * @param minutes - Duration in minutes
 */
export function expireInMinutes(minutes) {
    return { type: "duration", durationMs: minutes * 60 * 1000 };
}
/**
 * expireInHours sets the cache entry to expire after the specified hours.
 * @param hours - Duration in hours
 */
export function expireInHours(hours) {
    return { type: "duration", durationMs: hours * 60 * 60 * 1000 };
}
/**
 * expireDailyAt sets the cache entry to expire at a specific time each day (UTC).
 * @param hours - Hour (0-23)
 * @param minutes - Minutes (0-59)
 * @param seconds - Seconds (0-59)
 */
export function expireDailyAt(hours, minutes, seconds) {
    return { type: "time", hours, minutes, seconds };
}
/**
 * neverExpire sets the cache entry to never expire.
 * Note: Redis may still evict the key based on the eviction policy.
 */
export const neverExpire = "never";
/**
 * keepTTL preserves the existing TTL when updating a cache entry.
 * If the key doesn't exist, no TTL is set.
 */
export const keepTTL = "keep-ttl";
/**
 * Resolves an Expiry to a duration in milliseconds, "never", or "keep-ttl".
 * @internal
 */
export function resolveExpiry(expiry) {
    switch (expiry) {
        case "never":
            return "never";
        case "keep-ttl":
            return "keep-ttl";
    }
    switch (expiry.type) {
        case "duration":
            return expiry.durationMs;
        case "time": {
            const now = new Date();
            const target = new Date(now);
            target.setUTCHours(expiry.hours, expiry.minutes, expiry.seconds, 0);
            // If target time has passed today, set for tomorrow
            if (target.getTime() <= now.getTime()) {
                target.setUTCDate(target.getUTCDate() + 1);
            }
            return target.getTime() - now.getTime();
        }
    }
}
//# sourceMappingURL=expiry.js.map