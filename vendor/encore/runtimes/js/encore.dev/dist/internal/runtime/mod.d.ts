import { Runtime } from "./napi/napi.cjs";
export * from "./napi/napi.cjs";
export declare const RT: Runtime;
export interface Metric {
    name: string;
    services: string[];
}
export interface RuntimeConfig {
    metrics: Record<string, Metric>;
}
export declare function runtimeConfig(): RuntimeConfig;
