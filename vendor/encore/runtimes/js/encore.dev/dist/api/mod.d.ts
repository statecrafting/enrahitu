/// <reference types="node" />
import type { IncomingMessage, ServerResponse } from "http";
import { RequestMeta } from "../mod.js";
import { RawResponse } from "./mod.js";
import { RawRequest } from "./mod.js";
import { InternalHandlerResponse } from "../internal/appinit/mod.js";
import { IterableSocket, IterableStream, Sink } from "./stream.js";
export { RawRequest, RawResponse } from "./node_http.js";
export type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "TRACE" | "CONNECT";
export type Header<TypeOrName extends string | number | boolean | Date = string, Name extends string = ""> = TypeOrName extends string ? string : TypeOrName;
export type Query<TypeOrName extends string | string[] | number | number[] | boolean | boolean[] | Date | Date[] = string, Name extends string = ""> = TypeOrName extends string ? string : TypeOrName;
export type CookieWithOptions<T> = {
    value: T;
    expires?: Date;
    sameSite?: "Strict" | "Lax" | "None";
    domain?: string;
    path?: string;
    maxAge?: number;
    secure?: boolean;
    httpOnly?: boolean;
    partitioned?: boolean;
};
export type Cookie<TypeOrName extends string | number | boolean | Date = string, Name extends string = ""> = TypeOrName extends string ? CookieWithOptions<string> : CookieWithOptions<TypeOrName>;
export interface APIOptions {
    /**
     * The HTTP method(s) to match for this endpoint.
     * Use "*" to match any method.
     */
    method?: Method | Method[] | "*";
    /**
     * The request path to match for this endpoint.
     *
     * Use `:` to define single-segment parameters, e.g. `/users/:id`.
     * Use `*` to match any number of segments, e.g. `/files/*path`.
     *
     * If not specified, it defaults to `/<service-name>.<endpoint-name>`.
     */
    path?: string;
    /**
     * Whether or not to make this endpoint publicly accessible.
     * If false, the endpoint is only accessible from the internal network.
     *
     * Defaults to false if not specified.
     */
    expose?: boolean;
    /**
     * Whether or not the request must contain valid authentication credentials.
     * If set to true and the request is not authenticated,
     * Encore returns a 401 Unauthorized error.
     *
     * Defaults to false if not specified.
     */
    auth?: boolean;
    /**
     * The maximum body size, in bytes. If the request body exceeds this value,
     * Encore stops request processing and returns an error.
     *
     * If left unspecified it defaults to a reasonable default (currently 2MiB).
     * If set to `null`, the body size is unlimited.
     **/
    bodyLimit?: number | null;
    /**
     * Tags to filter endpoints when generating clients and in middlewares.
     */
    tags?: string[];
    /**
     * When set to true, request information such as payloads and headers will be excluded from traces.
     */
    sensitive?: boolean;
}
export interface StreamOptions {
    /**
     * The request path to match for this endpoint.
     *
     * Use `:` to define single-segment parameters, e.g. `/users/:id`.
     * Use `*` to match any number of segments, e.g. `/files/*path`.
     *
     * If not specified, it defaults to `/<service-name>.<endpoint-name>`.
     */
    path?: string;
    /**
     * Whether or not to make this endpoint publicly accessible.
     * If false, the endpoint is only accessible from the internal network.
     *
     * Defaults to false if not specified.
     */
    expose?: boolean;
    /**
     * Whether or not the request must contain valid authentication credentials.
     * If set to true and the request is not authenticated,
     * Encore returns a 401 Unauthorized error.
     *
     * Defaults to false if not specified.
     */
    auth?: boolean;
    /**
     * Tags to filter endpoints when generating clients and in middlewares.
     */
    tags?: string[];
    /**
     * When set to true, request information such as payloads and headers will be excluded from traces.
     */
    sensitive?: boolean;
}
/** @internal */
type HandlerFn<Params, Response> = Params extends void ? () => Promise<Response> : (params: Params) => Promise<Response>;
export declare function api<Params extends object | void = void, Response extends object | void = void>(options: APIOptions, fn: (params: Params) => Promise<Response>): HandlerFn<Params, Response>;
export declare function api<Params extends object | void = void, Response extends object | void = void>(options: APIOptions, fn: (params: Params) => Response): HandlerFn<Params, Response>;
export declare namespace api {
    export var raw: (options: APIOptions, fn: RawHandler) => RawHandler;
    export var streamInOut: {
        <HandshakeData, Request_1, Response_1>(options: StreamOptions, fn: (data: HandshakeData, stream: StreamInOut<Request_1, Response_1>) => Promise<void>): StreamInOutHandlerFn<HandshakeData, Request_1, Response_1>;
        <Request_2, Response_2>(options: StreamOptions, fn: (stream: StreamInOut<Request_2, Response_2>) => Promise<void>): (stream: StreamInOut<Request_2, Response_2>) => Promise<void>;
    };
    export var streamIn: {
        <Request_1>(options: StreamOptions, fn: (stream: StreamIn<Request_1>) => Promise<void>): (stream: StreamIn<Request_1>) => Promise<void>;
        <Request_2, Response_1>(options: StreamOptions, fn: (stream: StreamIn<Request_2>) => Promise<Response_1>): (stream: StreamIn<Request_2>) => Promise<Response_1>;
        <HandshakeData, Request_3, Response_2>(options: StreamOptions, fn: (data: HandshakeData, stream: StreamIn<Request_3>) => Promise<Response_2>): StreamInHandlerFn<HandshakeData, Request_3, Response_2>;
    };
    export var streamOut: {
        <HandshakeData, Response_1>(options: StreamOptions, fn: (data: HandshakeData, stream: StreamOut<Response_1>) => Promise<void>): StreamOutHandlerFn<HandshakeData, Response_1>;
        <Response_2>(options: StreamOptions, fn: (stream: StreamOut<Response_2>) => Promise<void>): (stream: StreamOut<Response_2>) => Promise<void>;
    };
    var _a: (options: StaticOptions) => StaticAssets;
    export { _a as static };
}
export type RawHandler = (req: IncomingMessage, resp: ServerResponse) => void;
export interface StreamIn<Request> extends AsyncIterable<Request> {
    recv: () => Promise<Request>;
}
export interface StreamOutWithResponse<Request, Response> extends StreamOut<Request> {
    response: () => Promise<Response>;
}
export interface StreamOut<Response> {
    send: (msg: Response) => Promise<void>;
    close: () => Promise<void>;
}
export type StreamInOutHandlerFn<HandshakeData, Request, Response> = HandshakeData extends void ? (stream: StreamInOut<Request, Response>) => Promise<void> : (data: HandshakeData, stream: StreamInOut<Request, Response>) => Promise<void>;
export type StreamOutHandlerFn<HandshakeData, Response> = HandshakeData extends void ? (stream: StreamOut<Response>) => Promise<void> : (data: HandshakeData, stream: StreamOut<Response>) => Promise<void>;
export type StreamInHandlerFn<HandshakeData, Request, Response> = HandshakeData extends void ? (stream: StreamIn<Request>) => Promise<Response> : (data: HandshakeData, stream: StreamIn<Request>) => Promise<Response>;
export type StreamInOut<Request, Response> = StreamIn<Request> & StreamOut<Response>;
export interface StaticOptions {
    /**
     * The request path to match for this endpoint.
     *
     * Use `:` to define single-segment parameters, e.g. `/users/:id`.
     * Use `*` to match any number of segments, e.g. `/files/*path`.
     *
     * If not specified, it defaults to `/<service-name>.<endpoint-name>`.
     */
    path?: string;
    /**
     * Whether or not to make this endpoint publicly accessible.
     * If false, the endpoint is only accessible from the internal network.
     *
     * Defaults to false if not specified.
     */
    expose?: boolean;
    /**
     * Whether or not the request must contain valid authentication credentials.
     * If set to true and the request is not authenticated,
     * Encore returns a 401 Unauthorized error.
     *
     * Defaults to false if not specified.
     */
    auth?: boolean;
    /**
     * The relative path to the directory containing the static files to serve.
     *
     * The provided path must be a subdirectory from the calling file's directory.
     */
    dir: string;
    /**
     * Path to the file to serve when the requested file is not found.
     * The path must be a relative path to within the calling file's directory.
     */
    notFound?: string;
    /**
     * Http Status code used when serving notFound fallback.
     * Defaults to 404.
     */
    notFoundStatus?: number;
    /**
     * Custom HTTP headers to apply to all static files served.
     *
     * @example
     * ```typescript
     * headers: {
     *   "Cache-Control": "public, max-age=3600",
     *   "X-Content-Type-Options": "nosniff",
     * }
     * ```
     */
    headers?: Record<string, string | string[]>;
}
export declare class StaticAssets {
    readonly options: StaticOptions;
    constructor(options: StaticOptions);
}
export interface MiddlewareOptions {
    /**
     * Configuration for what endpoints that should be targeted by the middleware
     */
    target?: {
        /**
         * If set, only run middleware on endpoints that are either exposed or not
         * exposed.
         */
        expose?: boolean;
        /**
         * If set, only run middleware on endpoints that either require or not
         * requires auth.
         */
        auth?: boolean;
        /**
         * If set, only run middleware on endpoints that are raw endpoints.
         */
        isRaw?: boolean;
        /**
         * If set, only run middleware on endpoints that are stream endpoints.
         */
        isStream?: boolean;
        /**
         * If set, only run middleware on endpoints that have specific tags.
         * These tags are evaluated with OR, meaning the middleware applies to an
         * API if the API has at least one of those tags.
         */
        tags?: string[];
    };
}
export declare class MiddlewareRequest {
    private _reqMeta?;
    private _stream?;
    private _rawReq?;
    private _rawResp?;
    private _data?;
    constructor(stream?: IterableStream | IterableSocket | Sink, rawReq?: RawRequest, rawResp?: RawResponse);
    /**
     * requestMeta is set when the handler is a typed handler or a stream handler.
     * for raw handlers, see rawRequest and rawResponse.
     */
    get requestMeta(): RequestMeta | undefined;
    /**
     * stream is set when the handler is a stream handler.
     */
    get stream(): IterableStream | IterableSocket | Sink | undefined;
    /**
     * rawRequest is set when the handler is a raw request handler.
     *
     * The returned value is a Node.js `http.IncomingMessage`.
     */
    get rawRequest(): RawRequest | undefined;
    /**
     * rawResponse is set when the handler is a raw request handler.
     *
     * The returned value is a Node.js `http.ServerResponse`.
     */
    get rawResponse(): RawResponse | undefined;
    /**
     * data can be used to pass data from middlewares to the handler.
     * The data will be available via `currentRequest()`
     */
    get data(): Record<string, any>;
}
export declare class ResponseHeader {
    headers: Record<string, string | string[]>;
    constructor();
    /**
     * set will set a header value for a key, if a previous middleware has
     * already set a value, it will be overridden.
     */
    set(key: string, value: string | string[]): void;
    /**
     * add adds a header value to a key, if a previous middleware has
     * already set a value, they will be appended.
     */
    add(key: string, value: string | string[]): void;
}
export declare class HandlerResponse {
    /**
     * The payload returned by the handler when the handler is either
     * a typed handler or stream handler.
     */
    payload: any;
    private _headers?;
    private _status?;
    constructor(payload: any);
    /**
     * header can be used by middlewares to set headers to the
     * response. This only works for typed handler. For raw handlers
     * see MiddlewareRequest.rawResponse.
     */
    get header(): ResponseHeader;
    /**
     * Override the http status code for successful requests for typed endpoints.
     */
    set status(s: number);
    /**
     * __internalToResponse converts a response to the internal representation
     * @internal
     */
    __internalToResponse(): InternalHandlerResponse;
}
export type Next = (req: MiddlewareRequest) => Promise<HandlerResponse>;
export type MiddlewareFn = (req: MiddlewareRequest, next: Next) => Promise<HandlerResponse>;
export interface Middleware extends MiddlewareFn {
    options?: MiddlewareOptions;
}
export declare function middleware(m: MiddlewareFn): Middleware;
export declare function middleware(options: MiddlewareOptions, fn: MiddlewareFn): Middleware;
/**
 * Options when making api calls.
 *
 * This interface will be extended with additional fields from
 * app's generated code.
 */
export interface CallOpts {
}
export { HttpStatusValues } from "./httpstatus.js";
import { HttpStatusValues } from "./httpstatus.js";
/** A map of HTTP status code names to their numeric values. */
export declare const HttpStatus: {
    readonly Continue: 100;
    readonly SwitchingProtocols: 101;
    readonly Processing: 102;
    readonly EarlyHints: 103;
    readonly OK: 200;
    readonly Created: 201;
    readonly Accepted: 202;
    readonly NonAuthoritativeInformation: 203;
    readonly NoContent: 204;
    readonly ResetContent: 205;
    readonly PartialContent: 206;
    readonly MultiStatus: 207;
    readonly AlreadyReported: 208;
    readonly IMUsed: 226;
    readonly MultipleChoices: 300;
    readonly MovedPermanently: 301;
    readonly Found: 302;
    readonly SeeOther: 303;
    readonly NotModified: 304;
    readonly UseProxy: 305;
    readonly SwitchProxy: 306;
    readonly TemporaryRedirect: 307;
    readonly PermanentRedirect: 308;
    readonly BadRequest: 400;
    readonly Unauthorized: 401;
    readonly PaymentRequired: 402;
    readonly Forbidden: 403;
    readonly NotFound: 404;
    readonly MethodNotAllowed: 405;
    readonly NotAcceptable: 406;
    readonly ProxyAuthenticationRequired: 407;
    readonly RequestTimeout: 408;
    readonly Conflict: 409;
    readonly Gone: 410;
    readonly LengthRequired: 411;
    readonly PreconditionFailed: 412;
    readonly PayloadTooLarge: 413;
    readonly URITooLong: 414;
    readonly UnsupportedMediaType: 415;
    readonly RangeNotSatisfiable: 416;
    readonly ExpectationFailed: 417;
    readonly ImATeapot: 418;
    readonly MisdirectedRequest: 421;
    readonly UnprocessableEntity: 422;
    readonly Locked: 423;
    readonly FailedDependency: 424;
    readonly TooEarly: 425;
    readonly UpgradeRequired: 426;
    readonly PreconditionRequired: 428;
    readonly TooManyRequests: 429;
    readonly RequestHeaderFieldsTooLarge: 431;
    readonly UnavailableForLegalReasons: 451;
    readonly InternalServerError: 500;
    readonly NotImplemented: 501;
    readonly BadGateway: 502;
    readonly ServiceUnavailable: 503;
    readonly GatewayTimeout: 504;
    readonly HTTPVersionNotSupported: 505;
    readonly VariantAlsoNegotiates: 506;
    readonly InsufficientStorage: 507;
    readonly LoopDetected: 508;
    readonly NotExtended: 510;
    readonly NetworkAuthenticationRequired: 511;
};
/** The union of all HTTP status code numeric values. */
export type HttpStatus = (typeof HttpStatusValues)[keyof typeof HttpStatusValues];
export { APIError, ErrCode } from "./error.js";
export type { ErrDetails } from "./error.js";
export { Gateway, type GatewayConfig } from "./gateway.js";
export { IterableSocket, IterableStream, Sink } from "./stream.js";
