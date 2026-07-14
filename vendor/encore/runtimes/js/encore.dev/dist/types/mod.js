import * as runtime from "../internal/runtime/mod.js";
/**
 * A decimal type that can hold values with arbitrary precision.
 * Unlike JavaScript's native number type, this can accurately represent
 * decimal values without floating-point precision errors.
 */
export class Decimal {
    impl;
    constructor(value) {
        this.impl = new runtime.Decimal(String(value));
    }
    static fromImpl(impl) {
        const d = Object.create(Decimal.prototype);
        d.impl = impl;
        return d;
    }
    toImpl(value) {
        return value instanceof Decimal
            ? value.impl
            : new runtime.Decimal(String(value));
    }
    /**
     * Adds this decimal to another decimal value.
     */
    add(d) {
        return Decimal.fromImpl(this.impl.add(this.toImpl(d)));
    }
    /**
     * Subtracts another decimal value from this decimal.
     */
    sub(d) {
        return Decimal.fromImpl(this.impl.sub(this.toImpl(d)));
    }
    /**
     * Multiplies this decimal by another decimal value.
     */
    mul(d) {
        return Decimal.fromImpl(this.impl.mul(this.toImpl(d)));
    }
    /**
     * Divides this decimal by another decimal value.
     */
    div(d) {
        return Decimal.fromImpl(this.impl.div(this.toImpl(d)));
    }
    get value() {
        return this.impl.toString();
    }
    toJSON() {
        return this.impl.toString();
    }
    toString() {
        return this.impl.toString();
    }
    [Symbol.toPrimitive](hint) {
        if (hint === "number") {
            return +this.value;
        }
        return this.value;
    }
    get __encore_decimal() {
        return true;
    }
}
//# sourceMappingURL=mod.js.map