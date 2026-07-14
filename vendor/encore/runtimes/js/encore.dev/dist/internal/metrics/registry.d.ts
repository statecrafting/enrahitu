import * as runtime from "../runtime/mod.js";
/**
 * Called during encores initialization
 * @internal
 */
export declare function setGlobalMetricsBuffer(buffer: SharedArrayBuffer): void;
/**
 * Called during encores initialization, should be called on the main thread
 * @internal
 */
export declare function initGlobalMetricsBuffer(): SharedArrayBuffer;
export declare function getRegistry(): runtime.MetricsRegistry | undefined;
export declare function getBuffer(): SharedArrayBuffer | undefined;
