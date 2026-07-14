/**
 * Internal class that handles atomic counter operations on SharedArrayBuffer.
 */
export declare class AtomicCounter {
    private view;
    private slot;
    constructor(buffer: SharedArrayBuffer, slot: number);
    increment(value?: number): void;
}
/**
 * Internal class that handles atomic gauge operations on SharedArrayBuffer.
 */
export declare class AtomicGauge {
    private view;
    private slot;
    constructor(buffer: SharedArrayBuffer, slot: number);
    set(value: number): void;
}
/**
 * Serialize labels to a consistent string key for map lookups.
 * @internal
 */
export declare function serializeLabels(labels: Record<string, string | number | boolean>): string;
/**
 * Process labels into an array of key/value pairs, converting numbers to floored integers.
 * @internal
 */
export declare function processLabelsToPairs(labels: Record<string, string | number | boolean>): [string, string][];
