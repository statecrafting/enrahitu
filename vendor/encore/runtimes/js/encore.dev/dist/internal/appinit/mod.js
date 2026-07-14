import { isMainThread, Worker, workerData } from "node:worker_threads";
import { MiddlewareRequest, HandlerResponse } from "../../api/mod.js";
import { IterableSocket, IterableStream, Sink } from "../../api/stream.js";
import { RawRequest, RawResponse } from "../../api/node_http.js";
import { setCurrentRequest } from "../reqtrack/mod.js";
import * as runtime from "../runtime/mod.js";
import { fileURLToPath } from "node:url";
import { initGlobalMetricsBuffer, setGlobalMetricsBuffer } from "../metrics/registry.js";
export function registerHandlers(handlers) {
    runtime.RT.registerHandlers(handlers.map((h) => transformHandler(h)));
}
export function registerTestHandler(handler) {
    runtime.RT.registerTestHandler(transformHandler(handler));
}
export function registerGateways(gateways) {
    // This function exists to ensure gateways are imported and executed.
    // It intentionally doesn't need to do anything.
}
export async function run(entrypoint) {
    if (isMainThread) {
        // Suppress Node.js's default signal handling. Without this, Node.js
        // receives the signal and tears down the event loop (clearing timers,
        // pending promises, etc.), which prevents in-flight request handlers from
        // completing. The Rust runtime handles signals for graceful shutdown,
        // including force-exit on a second signal.
        process.on("SIGINT", () => { });
        process.on("SIGTERM", () => { });
        if (process.platform === "win32") {
            // On Windows, Ctrl+Break delivers SIGBREAK and console close delivers SIGHUP.
            process.on("SIGBREAK", () => { });
            process.on("SIGHUP", () => { });
        }
        const metricsBuffer = initGlobalMetricsBuffer();
        const workers = [];
        const extraWorkers = runtime.RT.numWorkerThreads() - 1;
        if (extraWorkers > 0) {
            const path = fileURLToPath(entrypoint);
            for (let i = 0; i < extraWorkers; i++) {
                workers.push(new Worker(path, {
                    workerData: { metricsBuffer }
                }));
            }
        }
        // Resolves once the Rust runtime has requested a process exit: graceful
        // shutdown completed (drained requests and pubsub, flushed traces and
        // metrics), the shutdown deadline was exceeded, or the runtime crashed.
        let exitCode;
        try {
            exitCode = await runtime.RT.runForever();
        }
        catch (err) {
            console.error("encore: runtime failed while awaiting shutdown:", err);
            exitCode = 1;
        }
        // Exit from the main thread so Node tears down through its own orderly
        // path (stdio flush, 'exit' handlers, env teardown). Exiting from a
        // background thread instead runs exit-time teardown concurrently with
        // live JS threads, which segfaults. Stop worker threads first so none
        // of them executes JS while the process exits; if a worker is wedged
        // (e.g. stuck in native code, so terminate() never settles), the
        // Rust-side backstop that armed when the exit was requested still
        // force-terminates the process.
        await Promise.allSettled(workers.map((w) => w.terminate()));
        process.exit(exitCode);
    }
    // Worker thread: set metrics buffer from workerData
    if (workerData && workerData.metricsBuffer) {
        setGlobalMetricsBuffer(workerData.metricsBuffer);
    }
    // This is a worker thread. The runtime is already initialized, so block forever.
    await new Promise(() => { });
}
// recursively calls all middlewares
async function invokeMiddlewareChain(curReq, req, chain, handler) {
    const execute = async (index, req) => {
        const currentMiddleware = chain.at(index);
        // no more middlewares, execute the handler
        if (currentMiddleware === undefined) {
            const mwData = req.data;
            if (mwData !== undefined) {
                curReq.middlewareData = mwData;
            }
            return new HandlerResponse(await handler());
        }
        // execute current middleware
        return currentMiddleware(req, (req) => {
            return execute(index + 1, req);
        });
    };
    return (await execute(0, req)).__internalToResponse();
}
// calculate what middlewares should run for an endpoint
function calculateMiddlewareChain(endpointOptions, ms) {
    const middlewares = ms.filter((m) => {
        const target = m.options?.target;
        if (!target)
            return true;
        const { auth, expose, isRaw, isStream, tags } = target;
        return ((auth === undefined || auth === endpointOptions.auth) &&
            (expose === undefined || expose === endpointOptions.expose) &&
            (isRaw === undefined || isRaw === endpointOptions.isRaw) &&
            (isStream === undefined || isStream === endpointOptions.isStream) &&
            (tags === undefined ||
                tags.some((tag) => endpointOptions.tags.includes(tag))));
    });
    return middlewares;
}
function transformHandler(h) {
    const middlewares = calculateMiddlewareChain(h.endpointOptions, h.middlewares);
    if (h.apiRoute.streamingResponse || h.apiRoute.streamingRequest) {
        return {
            ...h.apiRoute,
            // req is the upgrade request.
            // stream is either a bidirectional stream, in stream or out stream.
            handler: (req, stream) => {
                setCurrentRequest(req);
                // make readable streams async iterators
                const streamArg = stream instanceof runtime.Stream
                    ? new IterableStream(stream)
                    : stream instanceof runtime.Socket
                        ? new IterableSocket(stream)
                        : new Sink(stream);
                if (middlewares.length === 0) {
                    const payload = req.payload();
                    return toResponse(payload !== null
                        ? h.apiRoute.handler(payload, streamArg)
                        : h.apiRoute.handler(streamArg));
                }
                const handler = async () => {
                    // handshake payload
                    const payload = req.payload();
                    return payload !== null
                        ? h.apiRoute.handler(payload, streamArg)
                        : h.apiRoute.handler(streamArg);
                };
                const mwRequest = new MiddlewareRequest(streamArg, undefined, undefined);
                return invokeMiddlewareChain(req, mwRequest, middlewares, handler);
            }
        };
    }
    if (h.apiRoute.raw) {
        return {
            ...h.apiRoute,
            handler: (req, resp, body) => {
                setCurrentRequest(req);
                const rawReq = new RawRequest(req, body);
                const rawResp = new RawResponse(rawReq, resp);
                if (middlewares.length === 0) {
                    return toResponse(h.apiRoute.handler(rawReq, rawResp));
                }
                const handler = async () => {
                    return h.apiRoute.handler(rawReq, rawResp);
                };
                const mwRequest = new MiddlewareRequest(undefined, rawReq, rawResp);
                return invokeMiddlewareChain(req, mwRequest, middlewares, handler);
            }
        };
    }
    return {
        ...h.apiRoute,
        handler: (req) => {
            setCurrentRequest(req);
            if (middlewares.length === 0) {
                const payload = req.payload();
                return toResponse(payload !== null ? h.apiRoute.handler(payload) : h.apiRoute.handler());
            }
            const handler = async () => {
                const payload = req.payload();
                return payload !== null
                    ? h.apiRoute.handler(payload)
                    : h.apiRoute.handler();
            };
            const mwRequest = new MiddlewareRequest(undefined, undefined, undefined);
            return invokeMiddlewareChain(req, mwRequest, middlewares, handler);
        }
    };
}
function toResponse(payload) {
    if (payload instanceof Promise) {
        return payload.then((payload) => {
            return new HandlerResponse(payload).__internalToResponse();
        });
    }
    else {
        return new HandlerResponse(payload).__internalToResponse();
    }
}
//# sourceMappingURL=mod.js.map