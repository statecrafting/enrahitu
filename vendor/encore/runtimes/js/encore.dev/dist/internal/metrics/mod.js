/**
 * Internal class that handles atomic counter operations on SharedArrayBuffer.
 */
export class AtomicCounter {
    view;
    slot;
    constructor(buffer, slot) {
        this.view = new BigUint64Array(buffer);
        this.slot = slot;
    }
    increment(value = 1) {
        const v = BigInt(Math.floor(value));
        Atomics.add(this.view, this.slot, v);
    }
}
/**
 * Internal class that handles atomic gauge operations on SharedArrayBuffer.
 */
export class AtomicGauge {
    view;
    slot;
    constructor(buffer, slot) {
        this.view = new BigUint64Array(buffer);
        this.slot = slot;
    }
    set(value) {
        // For gauges, store f64 bits as u64
        const float64 = new Float64Array(1);
        float64[0] = value;
        const uint64View = new BigUint64Array(float64.buffer);
        const v = uint64View[0];
        Atomics.store(this.view, this.slot, v);
    }
}
/**
 * Serialize labels to a consistent string key for map lookups.
 * @internal
 */
export function serializeLabels(labels) {
    const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify(sorted);
}
/**
 * Process labels into an array of key/value pairs, converting numbers to floored integers.
 * @internal
 */
export function processLabelsToPairs(labels) {
    return Object.entries(labels).map(([key, value]) => [
        key,
        typeof value === "number" ? String(Math.floor(value)) : String(value)
    ]);
}
//# sourceMappingURL=mod.js.map