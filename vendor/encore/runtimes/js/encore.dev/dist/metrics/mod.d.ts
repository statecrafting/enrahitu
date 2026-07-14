/**
 * Custom metrics for Encore applications.
 *
 * This module provides counters and gauges that can be statically analyzed
 * by the Encore compiler and automatically exported to observability backends.
 *
 * @example Simple counter
 * ```typescript
 * import { Counter } from 'encore.dev/metrics';
 *
 * export const ordersProcessed = new Counter("orders_processed");
 *
 * ordersProcessed.increment();
 * ```
 *
 * @example Counter with labels
 * ```typescript
 * import { CounterGroup } from 'encore.dev/metrics';
 *
 * interface Labels {
 *   success: boolean;
 * }
 *
 * export const ordersProcessed = new CounterGroup<Labels>("orders_processed");
 *
 * ordersProcessed.with({ success: true }).increment();
 * ```
 */
export interface MetricConfig {
}
/**
 * A Counter tracks cumulative values that only increase.
 * Use counters for metrics like request counts, errors, etc.
 */
export declare class Counter {
    private name;
    private cache;
    private labelPairs;
    private cfg;
    constructor(name: string, cfg?: MetricConfig);
    /**
     * Increment the counter by the given value (default 1).
     */
    increment(value?: number): void;
    ref(): Counter;
}
/**
 * A CounterGroup tracks counters with labels.
 * Each unique combination of label values creates a separate counter time series.
 *
 * @typeParam L - The label interface (must have string/number/boolean fields)
 * Note: Number values in labels are converted to integers using Math.floor().
 */
export declare class CounterGroup<L extends Record<keyof L, string | number | boolean>> {
    private name;
    private labelCache;
    private cfg;
    constructor(name: string, cfg?: MetricConfig);
    /**
     * Get a counter for the given label values.
     *
     * Note: Number values in labels are converted to integers using Math.floor().
     */
    with(labels: L): Counter;
    ref(): CounterGroup<L>;
}
/**
 * A Gauge tracks values that can go up or down.
 * Use gauges for metrics like memory usage, active connections, temperature, etc.
 */
export declare class Gauge {
    private name;
    private cache;
    private labelPairs;
    private cfg;
    constructor(name: string, cfg?: MetricConfig);
    /**
     * Set the gauge to the given value.
     */
    set(value: number): void;
    ref(): Gauge;
}
export declare class GaugeGroup<L extends Record<keyof L, string | number | boolean>> {
    private name;
    private labelCache;
    private cfg;
    constructor(name: string, cfg?: MetricConfig);
    /**
     * Get a gauge for the given label values.
     *
     * Note: Number values in labels are converted to integers using Math.floor().
     */
    with(labels: L): Gauge;
    ref(): GaugeGroup<L>;
}
