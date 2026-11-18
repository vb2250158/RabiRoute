import { compileApiContract, type ApiOperationContract, type ApiOperationDefinition, type ApiOperationStream } from "@rabiroute/host-api/manager/apiOperationContract";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { selectNapcatApiInstance, verifyNapcatApiIdentity, NapcatApiError, napcatApiFailure, type NapcatApiTransportContext } from "../manager/napcatApiTransport.js";
import { openNapcatProtocolFrames } from "./protocolFrames.js";
/** This fixed diagnostic action is registered by the installed distribution, and is not marked upstream testOnly. */
export function createNapcatTestStreamOperation(context: NapcatApiTransportContext): ApiOperationDefinition {
    const empty = { type: "object", additionalProperties: false };
    const frameSchema = { oneOf: [
            { type: "object", additionalProperties: false, required: ["type", "data_type", "data"], properties: {
                    type: { const: "stream" }, data_type: { const: "data_chunk" }, data: { type: "string", pattern: "^Index-> (?:[1-9]|10)$" }
                } },
            { type: "object", additionalProperties: false, required: ["type", "data_type", "data"], properties: {
                    type: { const: "response" }, data_type: { const: "data_complete" }, data: { const: "Stream transmission complete" }
                } }
        ] };
    const contract: ApiOperationContract = {
        operationId: "agent.qq.onebot.test_download_stream", aliases: ["agent.qq.onebot.test_download_stream_async", "agent.qq.onebot.test_download_stream_rate_limited"],
        contractVersion: "1.0.0", method: "POST", pathTemplate: "/api/agent/qq/onebot/test_download_stream", exposure: "public", transport: "sse",
        description: "Actual installed native diagnostic stream: ten ordered Index frames, followed by completion at native EOF. It does not send QQ messages or access files. The optional error flag deliberately exercises the native failure path; an interface name containing test does not imply a disabled action.",
        request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "json", maxBytes: qqReadSettings.jsonBytes, schema: {
                    type: "object", additionalProperties: false, required: ["routeId", "instanceId", "params"], properties: {
                        routeId: { type: "string", minLength: 1, maxLength: 256 }, instanceId: { type: "string", minLength: 1, maxLength: 256 },
                        params: { type: "object", additionalProperties: false, properties: { error: { type: "boolean" } } }
                    }
                } } },
        responses: { "200": { mediaType: "text/event-stream; charset=utf-8", stream: { framing: "sse-json", maxFrameBytes: qqReadSettings.jsonBytes,
                    frameSchema: { type: "object", additionalProperties: false, required: ["data"], properties: { data: frameSchema } },
                    completion: "Only all ten original ordered frames, exact native completion and EOF establish completion.",
                    cancellation: "Cancel and join the original HTTP body reader and local SSE producer. No additional native process is launched." } },
            default: { mediaType: "application/json", schema: { type: "object", required: ["code", "errorCode"], properties: { code: { const: -1 }, errorCode: { type: "string" } } } } },
        effects: { mode: "read", description: "Read only the installed fixed native diagnostic frame sequence under the original Route/instance/account authority." },
        recovery: { strategy: "repeat-explicit-diagnostic-read", description: "Incomplete or deliberately failed streams have no successful completion. No message, file or business request is replayed." },
        validators: [{ id: "napcat.fixed-diagnostic-frames", description: "Original account fences, configured deadline/frame quota, exactly ten ordered native frames and EOF completion." }]
    };
    const validator = compileApiContract({ contract }).bodyValidator!;
    return { contract, async handler(input) {
            let cleanup: (() => void) | undefined;
            try {
                if (!validator(input.body))
                    throw new NapcatApiError(400, "QQ_NATIVE_STREAM_INPUT_INVALID");
                const body = input.body as {
                    routeId: string;
                    instanceId: string;
                    params: {
                        error?: boolean;
                    };
                };
                const controller = new AbortController();
                const abort = () => controller.abort(input.signal?.reason);
                input.signal?.addEventListener("abort", abort, { once: true });
                if (input.signal?.aborted)
                    abort();
                const timer = setTimeout(() => controller.abort(), qqReadSettings.readTimeoutMs);
                cleanup = () => {
                    clearTimeout(timer);
                    input.signal?.removeEventListener("abort", abort);
                };
                const selection = selectNapcatApiInstance(context, input.request, body.routeId, body.instanceId, controller.signal);
                await verifyNapcatApiIdentity(context, selection, controller.signal);
                const response = await (context.transport ?? fetch)(new URL("test_download_stream", selection.httpUrl + "/"), {
                    method: "POST", redirect: "error", signal: controller.signal, body: JSON.stringify({ error: body.params.error ?? false }),
                    headers: { "content-type": "application/json", ...(selection.accessToken ? { authorization: `Bearer ${selection.accessToken}` } : {}) }
                });
                const native = openNapcatProtocolFrames(response, controller.signal, qqReadSettings.jsonBytes);
                const release = cleanup;
                const stream: ApiOperationStream = { signal: controller.signal,
                    cancel: async (reason) => {
                        controller.abort(reason);
                        await native.cancel();
                        release();
                    },
                    frames: (async function* () {
                        let chunks = 0;
                        let complete = false;
                        try {
                            for await (const frame of native.frames) {
                                selection.assertCurrent();
                                if (complete)
                                    throw new NapcatApiError(503, "QQ_NATIVE_TEST_STREAM_INVALID");
                                if (frame.type === "stream" && frame.data_type === "data_chunk" && chunks < 10 && frame.data === `Index-> ${chunks + 1}`) {
                                    chunks++;
                                    yield { data: { type: "stream", data_type: "data_chunk", data: frame.data } };
                                }
                                else if (frame.type === "response" && frame.data_type === "data_complete" && chunks === 10 && frame.data === "Stream transmission complete") {
                                    complete = true;
                                }
                                else
                                    throw new NapcatApiError(503, "QQ_NATIVE_TEST_STREAM_INVALID");
                            }
                            if (!complete)
                                throw new NapcatApiError(503, "QQ_NATIVE_TEST_STREAM_INCOMPLETE");
                            await verifyNapcatApiIdentity(context, selection, controller.signal);
                            yield { data: { type: "response", data_type: "data_complete", data: "Stream transmission complete" } };
                        }
                        finally {
                            await native.cancel();
                            release();
                        }
                    })()
                };
                cleanup = undefined;
                return { status: 200, stream, headers: { "cache-control": "private, no-store" } };
            }
            catch (error) {
                cleanup?.();
                return napcatApiFailure(error);
            }
        } };
}
