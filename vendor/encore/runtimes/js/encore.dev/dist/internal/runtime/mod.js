import { Decimal } from "../../types/mod.js";
import { Runtime } from "./napi/napi.cjs";
export * from "./napi/napi.cjs";
const testMode = process.env.NODE_ENV === "test";
export const RT = new Runtime({
    testMode,
    typeConstructors: {
        decimal: (val) => new Decimal(val)
    }
});
let cached = null;
export function runtimeConfig() {
    if (cached === null) {
        let cfg = RT.runtimeConfig();
        cached = {
            metrics: cfg.metrics
        };
    }
    return cached;
}
//# sourceMappingURL=mod.js.map