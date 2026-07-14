type durationUnit = "ns" | "µs" | "ms" | "s" | "m" | "h";
type durationComponent = `${number}${durationUnit}`;
/**
 * A duration is a string representing a length of time.
 *
 * Examples: `"10s"`, `"500ms"`, `"5m"`, `"1h30m"`, `"1h 30m"`.
 */
export type DurationString = durationComponent | `${durationComponent}${durationComponent}` | `${durationComponent} ${durationComponent}`;
export type ToDecimal = string | number | bigint;
/**
 * A decimal type that can hold values with arbitrary precision.
 * Unlike JavaScript's native number type, this can accurately represent
 * decimal values without floating-point precision errors.
 */
export declare class Decimal {
    private impl;
    constructor(value: ToDecimal);
    private static fromImpl;
    private toImpl;
    /**
     * Adds this decimal to another decimal value.
     */
    add(d: Decimal | ToDecimal): Decimal;
    /**
     * Subtracts another decimal value from this decimal.
     */
    sub(d: Decimal | ToDecimal): Decimal;
    /**
     * Multiplies this decimal by another decimal value.
     */
    mul(d: Decimal | ToDecimal): Decimal;
    /**
     * Divides this decimal by another decimal value.
     */
    div(d: Decimal | ToDecimal): Decimal;
    get value(): string;
    toJSON(): string;
    toString(): string;
    [Symbol.toPrimitive](hint: string): string | number;
    private get __encore_decimal();
}
export {};
