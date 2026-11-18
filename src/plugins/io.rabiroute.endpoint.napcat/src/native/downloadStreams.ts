import { compileApiContract, type ApiOperationContract, type ApiOperationDefinition, type ApiOperationStream } from "@rabiroute/host-api/manager/apiOperationContract";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import { readExactQqMessage } from "../manager/qqMessageRoutes.js";
import { qqMessageMedia } from "../manager/qqMessageMedia.js";
import { napcatApiAttachmentSourceSchema } from "../manager/napcatApiAttachments.js";
import { assertSourceGroupFileAccess } from "../manager/napcatApiSourceFiles.js";
import { NapcatApiError, napcatApiFailure, selectNapcatApiInstance, verifyNapcatApiIdentity, type NapcatApiTransportContext } from "../manager/napcatApiTransport.js";
import { openNativeDownloadFrames } from "./downloadFrames.js";
const actions = ["download_file_stream", "download_file_record_stream", "download_file_image_stream"] as const;
const empty = { type: "object", additionalProperties: false };
const id = { type: "string", minLength: 1, maxLength: 256 };
const integer = { type: "integer", minimum: 0 };
const frameSchema = { oneOf: [
        { type: "object", additionalProperties: false, required: ["type", "data_type", "file_name", "file_size", "chunk_size"], properties: {
                type: { const: "stream" }, data_type: { const: "file_info" }, file_name: { type: "string" }, file_size: integer,
                chunk_size: { type: "integer", minimum: 1 }, width: integer, height: integer, out_format: { type: "string" }
            } },
        { type: "object", additionalProperties: false, required: ["type", "data_type", "index", "data", "size"], properties: {
                type: { const: "stream" }, data_type: { const: "file_chunk" }, index: integer, data: { type: "string" }, size: { type: "integer", minimum: 1 }
            } },
        { type: "object", additionalProperties: false, required: ["type", "data_type", "total_chunks", "total_bytes"], properties: {
                type: { const: "response" }, data_type: { const: "file_complete" }, total_chunks: integer, total_bytes: integer
            } }
    ] };
type Body = {
    routeId: string;
    instanceId: string;
    params: {
        source?: {
            kind: "group" | "private";
            targetId: string;
            messageId: string;
            attachmentIndex: number;
        };
        group?: {
            groupId: string;
            fileId: string;
        };
        chunk_size?: number;
        out_format?: string;
    };
    timeoutMs?: number;
};
/** Real native streaming calls. Source references replace caller paths and Rabi exposes reviewed native frames through its existing SSE owner. */
export function createNapcatDownloadStreamOperations(context: NapcatApiTransportContext): readonly ApiOperationDefinition[] {
    const maxChunk = Math.max(1, Math.floor((qqReadSettings.jsonBytes - 4096) * 3 / 4));
    return actions.map(action => {
        const group = { type: "object", additionalProperties: false, required: ["groupId", "fileId"], properties: {
                groupId: { type: "string", pattern: "^[1-9][0-9]{0,15}$" }, fileId: { type: "string", pattern: "^[a-fA-F0-9]{32}$" }
            } };
        const params = { type: "object", additionalProperties: false,
            ...(action === "download_file_stream" ? { oneOf: [{ required: ["source"], properties: { source: {} } }, { required: ["group"], properties: { group: {} } }] } : { required: ["source"] }),
            properties: { source: napcatApiAttachmentSourceSchema, ...(action === "download_file_stream" ? { group } : {}),
                chunk_size: { type: "integer", minimum: 1, maximum: maxChunk },
                ...(action === "download_file_record_stream" ? { out_format: { enum: ["mp3", "amr", "wma", "m4a", "spx", "ogg", "wav", "flac"] } } : {}) }
        };
        const contract: ApiOperationContract = { operationId: `agent.qq.onebot.${action}`,
            aliases: [`agent.qq.onebot.${action}_async`, `agent.qq.onebot.${action}_rate_limited`], contractVersion: "1.0.0", method: "POST",
            pathTemplate: `/api/agent/qq/onebot/${action}`, exposure: "public", transport: "sse",
            description: "Source-bound native stream view. nativeContractEquivalent=false. The actual fixed native stream action resolves its original cached message/model reference and streams file_info/file_chunk/file_complete. Caller URLs and paths are not accepted. Native async queue semantics are not emulated.",
            request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "json", maxBytes: qqReadSettings.jsonBytes, schema: {
                        type: "object", additionalProperties: false, required: ["routeId", "instanceId", "params"], properties: {
                            routeId: id, instanceId: id, params, timeoutMs: { type: "integer", minimum: 1, maximum: 2147483647 }
                        }
                    } } },
            responses: { "200": { mediaType: "text/event-stream; charset=utf-8", stream: { framing: "sse-json", maxFrameBytes: qqReadSettings.jsonBytes,
                        frameSchema: { type: "object", additionalProperties: false, required: ["data"], properties: { data: frameSchema } }, completion: "Only EOF plus exact chunk ordering/count/byte totals permits the final completion frame. Native announced file_size may describe the original audio before conversion.",
                        cancellation: "Abort and join the original HTTP body reader and local frame producer. Native platform file-cache workloads remain owned by that process; no unsupported remote job cancellation is claimed." } },
                default: { mediaType: "application/json", schema: { type: "object", additionalProperties: false, required: ["code", "errorCode"], properties: {
                            code: { const: -1 }, errorCode: { type: "string" }
                        } } } },
            effects: { mode: "read", description: "Native source-bound download and optional native audio conversion use the platform's original resource owner. Rabi never opens the native host path." },
            recovery: { strategy: "original-source-read", description: "An incomplete stream is not a completed download. Read again only from the same original authorized source. No input or message is sent." },
            validators: [{ id: "napcat.original-source-and-stream", description: "Original source identity, account/Route fences, native frame shape, byte budget and reader cancellation remain enforced." }]
        };
        const compiled = compileApiContract({ contract });
        return { contract, handler: async (input) => {
                let release: (() => void) | undefined;
                try {
                    if (!compiled.bodyValidator?.(input.body))
                        throw new NapcatApiError(400, "QQ_NATIVE_STREAM_INPUT_INVALID");
                    const body = input.body as Body;
                    const selection = selectNapcatApiInstance(context, input.request, body.routeId, body.instanceId, input.signal);
                    const controller = new AbortController(), abort = () => controller.abort(input.signal?.reason);
                    input.signal?.addEventListener("abort", abort, { once: true });
                    if (input.signal?.aborted)
                        abort();
                    const timer = setTimeout(() => controller.abort(), body.timeoutMs ?? getTimeoutMs("qq.nativeStream", 60000));
                    release = () => {
                        clearTimeout(timer);
                        input.signal?.removeEventListener("abort", abort);
                    };
                    const current = () => {
                        controller.signal.throwIfAborted();
                        selection.assertCurrent();
                    };
                    await verifyNapcatApiIdentity(context, selection, controller.signal);
                    let fileId: string | undefined, name: string;
                    if (body.params.group) {
                        assertSourceGroupFileAccess(context, selection, body.params.group.groupId);
                        fileId = body.params.group.fileId;
                        name = "group-file.bin";
                    }
                    else {
                        const source = body.params.source!;
                        const message = await readExactQqMessage({ endpoint: selection, kind: source.kind, target: source.targetId,
                            messageId: source.messageId, signal: controller.signal, current, transport: context.transport });
                        current();
                        const media = qqMessageMedia(message.message)[source.attachmentIndex];
                        const expected = action === "download_file_image_stream" ? "image" : action === "download_file_record_stream" ? "audio" : undefined;
                        if (!media || expected && media.kind !== expected)
                            throw new NapcatApiError(422, "QQ_NATIVE_STREAM_KIND_MISMATCH");
                        fileId = media.file;
                        name = media.name;
                    }
                    if (!fileId || fileId.length > 4096 || /[\x00-\x1f\x7f]/.test(fileId))
                        throw new NapcatApiError(422, "QQ_NATIVE_STREAM_SOURCE_UNAVAILABLE");
                    const chunkBytes = body.params.chunk_size ?? Math.min(65536, maxChunk);
                    current();
                    const response = await (context.transport ?? fetch)(new URL(action, selection.httpUrl + "/"), { method: "POST", redirect: "error", signal: controller.signal,
                        headers: { "content-type": "application/json", ...(selection.accessToken ? { authorization: `Bearer ${selection.accessToken}` } : {}) },
                        body: JSON.stringify({ file_id: fileId, chunk_size: chunkBytes, ...(body.params.out_format ? { out_format: body.params.out_format } : {}) }) });
                    try {
                        current();
                    }
                    catch (error) {
                        await response.body?.cancel().catch(() => {
                        });
                        throw error;
                    }
                    if (response.status !== 200 || !response.body) {
                        await response.body?.cancel().catch(() => {
                        });
                        throw new NapcatApiError(503, "QQ_NATIVE_STREAM_HTTP_REJECTED");
                    }
                    const native = openNativeDownloadFrames(response, { signal: controller.signal, chunkBytes, maxBytes: qqReadSettings.mediaBytes,
                        maxFrameBytes: qqReadSettings.jsonBytes, name, outFormat: body.params.out_format,
                        allowConvertedSize: action === "download_file_record_stream" });
                    const cleanup = release;
                    const stream: ApiOperationStream = { signal: controller.signal,
                        cancel: async (reason) => {
                            controller.abort(reason);
                            await native.cancel();
                            cleanup();
                        },
                        frames: (async function* () {
                            try {
                                for await (const frame of native.frames) {
                                    current();
                                    if (frame.type === "response")
                                        await verifyNapcatApiIdentity(context, selection, controller.signal);
                                    yield { data: frame };
                                }
                            }
                            finally {
                                await native.cancel();
                                cleanup();
                            }
                        })()
                    };
                    release = undefined;
                    return { status: 200, stream, headers: { "cache-control": "private, no-store", "x-rabiroute-native-contract-equivalent": "false" } };
                }
                catch (error) {
                    release?.();
                    return napcatApiFailure(error);
                }
            } };
    });
}
