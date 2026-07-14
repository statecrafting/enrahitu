import * as runtime from "../runtime/mod.js";
import { RT } from "../runtime/mod.js";
import log from "../../log/mod.js";
let globalRegistry;
let globalBuffer;
let initErrorLogged = false;
const testMode = process.env.NODE_ENV === "test";
/**
 * Called during encores initialization
 * @internal
 */
export function setGlobalMetricsBuffer(buffer) {
    globalBuffer = buffer;
    globalRegistry = RT.getMetricsRegistry();
}
/**
 * Called during encores initialization, should be called on the main thread
 * @internal
 */
export function initGlobalMetricsBuffer() {
    const INITIAL_METRICS_SLOTS = 10000;
    const metricsBuffer = new SharedArrayBuffer(INITIAL_METRICS_SLOTS * 8);
    const view = new BigUint64Array(metricsBuffer);
    runtime.RT.createMetricsRegistry(view);
    setGlobalMetricsBuffer(metricsBuffer);
    return metricsBuffer;
}
export function getRegistry() {
    if (!globalRegistry) {
        // In test mode, silently return undefined (no-op)
        if (testMode) {
            return undefined;
        }
        // In non-test mode, log error once and return undefined
        if (!initErrorLogged) {
            initErrorLogged = true;
            log.error("Metrics registry not initialized. Metrics will not be collected. ");
        }
        return undefined;
    }
    return globalRegistry;
}
export function getBuffer() {
    if (!globalBuffer) {
        // In test mode, silently return undefined (no-op)
        if (testMode) {
            return undefined;
        }
        // In non-test mode, log error once and return undefined
        if (!initErrorLogged) {
            initErrorLogged = true;
            log.error("Metrics buffer not initialized. Metrics will not be collected. ");
        }
        return undefined;
    }
    return globalBuffer;
}
//# sourceMappingURL=registry.js.map