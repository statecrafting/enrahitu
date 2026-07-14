/**
 * CacheError is the base class for all cache-related errors.
 */
export declare class CacheError extends Error {
    constructor(msg: string);
}
/**
 * CacheMiss is thrown when a cache key is not found.
 */
export declare class CacheMiss extends CacheError {
    constructor(key: string);
}
/**
 * CacheKeyExists is thrown when attempting to set a key that already exists
 * using setIfNotExists.
 */
export declare class CacheKeyExists extends CacheError {
    constructor(key: string);
}
