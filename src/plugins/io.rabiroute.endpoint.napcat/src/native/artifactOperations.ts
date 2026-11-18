import { createHash } from "node:crypto";
import { compileApiContract, validateApiOperationResult, type ApiOperationContract, type ApiOperationDefinition, type ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import { executeDurableDelivery } from "@rabiroute/host-api/manager/durableDeliveryIdempotency";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import { consumeResolvedQqMediaBytes } from "../manager/qqMessageMedia.js";
import { callNapcatApi, NapcatApiError, napcatApiFailure, selectNapcatApiInstance, verifyNapcatApiIdentity, type NapcatApiTransportContext } from "../manager/napcatApiTransport.js";
import { NapcatArtifactObjects, type NativeArtifactBinding, type NativeResourceObjects } from "./artifactObjects.js";
import type { NativeProtectedResourceObjects } from "./protectedObjects.js";
type Action = "get_ai_record" | "get_flash_file_url";
type Body = {
    routeId: string;
    instanceId: string;
    deliveryId: string;
    params?: Record<string, string | number>;
    action?: Action;
    timeoutMs?: number;
};
export type NapcatArtifactContext = NapcatApiTransportContext & {
    rootDir: string;
    readOnly(): boolean;
    resourceObjects: NativeResourceObjects;
    protectedResourceObjects: NativeProtectedResourceObjects;
};
const actions = new Set<Action>(["get_ai_record", "get_flash_file_url"]);
const empty = { type: "object", additionalProperties: false };
const id = { type: "string", minLength: 1, maxLength: 256 };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const reference = { type: "object", additionalProperties: false, required: ["resourceId", "bytes", "sha256", "name", "mediaType"], properties: {
        resourceId: hash, bytes: { type: "integer", minimum: 0 }, sha256: hash, name: { type: "string" }, mediaType: { const: "application/octet-stream" }
    } };
const errorResponse = { mediaType: "application/json", schema: { type: "object", additionalProperties: false, required: ["code", "errorCode"],
        properties: { code: { const: -1 }, errorCode: { type: "string" } } } };
const parameters = {
    get_ai_record: { type: "object", additionalProperties: false, required: ["character", "group_id", "text"], properties: {
            character: { type: "string", minLength: 1 }, group_id: { type: "string", pattern: "^[1-9][0-9]{0,15}$" }, text: { type: "string", minLength: 1 }
        } },
    get_flash_file_url: { type: "object", additionalProperties: false, required: ["fileset_id"], properties: {
            fileset_id: { type: "string", minLength: 1 }, file_name: { type: "string" }, file_index: { type: "integer", minimum: 0 }
        } }
};
function baseContract(operationId: string, pathname: string, schema: Record<string, unknown>, binary = false, maxFrameBytes = 1048576): ApiOperationContract {
    return { operationId, contractVersion: "1.0.0", method: "POST", pathTemplate: pathname, exposure: "public", transport: "http",
        description: binary ? "Read the complete original delivery's verified artifact bytes from the shared resource owner. No native generation or transfer is repeated."
            : "Capture a fixed native result as a repeatably readable shared resource artifact. nativeContractEquivalent=false. Native URLs and host paths remain private.",
        request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "json", maxBytes: qqReadSettings.jsonBytes, schema } },
        responses: binary ? { "200": { mediaType: "application/octet-stream", stream: { framing: "bytes", maxFrameBytes, maxBytes: qqReadSettings.mediaBytes,
                    completion: "EOF only after original chunk and full SHA verification; final bytes are withheld until the actual QQ identity fence.",
                    cancellation: "Abort further reads and join any original bounded ResourceCache read before releasing the native owner." } }, default: errorResponse }
            : { "200": { mediaType: "application/json", schema: { type: "object", additionalProperties: false, required: ["code", "data", "delivery"], properties: {
                            code: { const: 0 }, data: reference, delivery: { type: "object" }
                        } } }, "202": { mediaType: "application/json", schema: { type: "object", additionalProperties: false, required: ["code", "delivery"], properties: {
                            code: { const: 0 }, delivery: { type: "object" }
                        } } }, default: errorResponse },
        effects: { mode: binary ? "read" : "external-mutation", description: binary ? "Only the original owner-bound resource objects are read."
                : "AI generation occurs once under the original durable receipt. Native file URL resolution and local artifact capture never expose a URL or raw native result." },
        recovery: { strategy: "original-durable-receipt-and-verified-artifact", description: "Only a complete, integrity-verified original manifest can settle recovery. Missing or partial artifacts stay unknown and never authorize another generation." },
        validators: [{ id: "napcat.native-artifact-binding", description: "Exact Route, instance, configured QQ, actual native identity, delivery and resource integrity are retained across awaits." }]
    };
}
function bodySchema(action?: Action) {
    return { type: "object", additionalProperties: false, required: ["routeId", "instanceId", "deliveryId", action ? "params" : "action"], properties: {
            routeId: id, instanceId: id, deliveryId: { type: "string", minLength: 1, maxLength: 200 },
            ...(action ? { params: parameters[action] } : { action: { enum: [...actions] } }),
            timeoutMs: { type: "integer", minimum: 1, maximum: 2147483647 }
        } };
}
/** The same shared ResourceCache instance is injected by host.manager.resourceObjects. */
export function createNapcatArtifactOperations(context: NapcatArtifactContext): readonly ApiOperationDefinition[] {
    const objects = new NapcatArtifactObjects(context.resourceObjects, context.protectedResourceObjects);
    const definitions = [...actions].map<ApiOperationDefinition>(action => {
        const contract = { ...baseContract(`agent.qq.onebot.${action}`, `/api/agent/qq/onebot/${action}`, bodySchema(action)),
            aliases: [`agent.qq.onebot.${action}_async`, `agent.qq.onebot.${action}_rate_limited`] };
        const compiled = compileApiContract({ contract });
        return { contract, discovery: { title: action, category: { id: "qq-onebot", title: "QQ / NapCat" }, relatedOperations: ["agent.qq.native-artifact.read"] },
            handler: async (input) => {
                try {
                    if (!compiled.bodyValidator?.(input.body))
                        throw new NapcatApiError(400, "QQ_NATIVE_RESOURCE_INPUT_INVALID");
                    if (context.readOnly())
                        throw new NapcatApiError(403, "QQ_API_READ_ONLY");
                    const body = input.body as Body;
                    const params = Object.fromEntries(Object.entries(body.params!).sort(([a], [b]) => a.localeCompare(b)));
                    const selection = selectNapcatApiInstance(context, input.request, body.routeId, body.instanceId, input.signal);
                    const binding: NativeArtifactBinding = { routeId: body.routeId, instanceId: body.instanceId, botUserId: selection.botUserId, action, deliveryId: body.deliveryId,
                        requestDigest: createHash("sha256").update(JSON.stringify(params)).digest("hex") };
                    const controller = new AbortController(), cancel = () => controller.abort(input.signal?.reason);
                    input.signal?.addEventListener("abort", cancel, { once: true });
                    const timer = setTimeout(() => controller.abort(), body.timeoutMs ?? getTimeoutMs("qq.nativeArtifact", 60000));
                    const current = () => {
                        controller.signal.throwIfAborted();
                        selection.assertCurrent();
                    };
                    try {
                        await verifyNapcatApiIdentity(context, selection, controller.signal);
                        const find = () => objects.find(binding, qqReadSettings.mediaBytes, current);
                        const outcome = await executeDurableDelivery({ rootDir: context.rootDir, namespace: "napcat-onebot-actions", deliveryId: body.deliveryId,
                            payload: { action, routeId: selection.routeId, instanceId: selection.instanceId, botUserId: selection.botUserId, params },
                            audit: { routeId: selection.routeId, instanceId: selection.instanceId, botUserId: selection.botUserId, action }, requestAuthority: current,
                            recoverExistingUncertain: true,
                            recover: async () => {
                                const found = await find();
                                return found ? { state: "completed", result: found } : { state: "uncertain", reason: "Original native artifact is not complete; generation is never replayed." };
                            },
                            deliver: async () => {
                                const existing = await find();
                                if (existing)
                                    return existing;
                                const native = await callNapcatApi(context, selection, action, params, actions, controller.signal);
                                let url: string;
                                if (action === "get_ai_record") {
                                    if (typeof native !== "string")
                                        throw new NapcatApiError(503, "QQ_NATIVE_RESOURCE_RESULT_INVALID");
                                    url = native;
                                }
                                else {
                                    const value = native as {
                                        result?: unknown;
                                        transferUrl?: unknown;
                                    } | null;
                                    if (value?.result !== 0 || typeof value.transferUrl !== "string")
                                        throw new NapcatApiError(503, "QQ_NATIVE_RESOURCE_RESULT_INVALID");
                                    url = value.transferUrl;
                                }
                                const result = await objects.putStream(binding, async (write) => {
                                    await consumeResolvedQqMediaBytes({ url }, { kind: "file", name: "native-resource" }, controller.signal, write, context.transport, { mode: "url-only", allowEmptyFile: action === "get_flash_file_url" });
                                    await verifyNapcatApiIdentity(context, selection, controller.signal);
                                }, action === "get_ai_record" ? "ai-voice.silk" : "flash-file.bin", current);
                                await verifyNapcatApiIdentity(context, selection, controller.signal);
                                return result;
                            } });
                        current();
                        await verifyNapcatApiIdentity(context, selection, controller.signal);
                        if (outcome.state === "conflict")
                            throw new NapcatApiError(409, "QQ_API_DELIVERY_CONFLICT");
                        const result = outcome.state === "completed" ? { status: 200, body: { code: 0, data: outcome.result,
                                delivery: { deliveryId: outcome.deliveryId, state: outcome.state, duplicate: outcome.duplicate } } }
                            : { status: 202, body: { code: 0, delivery: { deliveryId: outcome.deliveryId, state: outcome.state, retryable: false } } };
                        validateApiOperationResult(compiled, result);
                        return result;
                    }
                    finally {
                        clearTimeout(timer);
                        input.signal?.removeEventListener("abort", cancel);
                    }
                }
                catch (error) {
                    return napcatApiFailure(error);
                }
            } };
    });
    const contract = baseContract("agent.qq.native-artifact.read", "/api/agent/qq/native-artifacts/read", bodySchema(), true, context.resourceObjects.maxObjectBytes);
    const compiled = compileApiContract({ contract });
    definitions.push({ contract, handler: async (input) => {
            try {
                if (!compiled.bodyValidator?.(input.body))
                    throw new NapcatApiError(400, "QQ_NATIVE_RESOURCE_INPUT_INVALID");
                const body = input.body as Body;
                const selection = selectNapcatApiInstance(context, input.request, body.routeId, body.instanceId, input.signal);
                const controller = new AbortController(), cancel = () => controller.abort(input.signal?.reason);
                input.signal?.addEventListener("abort", cancel, { once: true });
                const timer = setTimeout(() => controller.abort(), body.timeoutMs ?? getTimeoutMs("qq.nativeArtifact", 60000));
                const current = () => {
                    controller.signal.throwIfAborted();
                    selection.assertCurrent();
                };
                let streamOwnsCleanup = false;
                const release = () => {
                    clearTimeout(timer);
                    input.signal?.removeEventListener("abort", cancel);
                };
                try {
                    await verifyNapcatApiIdentity(context, selection, controller.signal);
                    const binding = { routeId: body.routeId, instanceId: body.instanceId, botUserId: selection.botUserId, action: body.action!, deliveryId: body.deliveryId };
                    const reference = await objects.find(binding, qqReadSettings.mediaBytes, current);
                    if (!reference)
                        throw new NapcatApiError(503, "QQ_NATIVE_RESOURCE_UNAVAILABLE");
                    const value = await objects.openStream(binding, reference.resourceId, qqReadSettings.mediaBytes, current);
                    await verifyNapcatApiIdentity(context, selection, controller.signal);
                    const result = { status: 200, stream: { signal: controller.signal,
                            cancel: async (reason: unknown) => {
                                controller.abort(reason);
                                await value.frames.return();
                                release();
                            },
                            frames: (async function* () {
                                let pending: Buffer | undefined;
                                try {
                                    for await (const bytes of value.frames) {
                                        current();
                                        if (pending)
                                            yield pending;
                                        pending = bytes;
                                    }
                                    await verifyNapcatApiIdentity(context, selection, controller.signal);
                                    current();
                                    if (pending)
                                        yield pending;
                                }
                                finally {
                                    await value.frames.return();
                                    release();
                                }
                            })()
                        }, headers: { "content-type": "application/octet-stream", "cache-control": "private, no-store",
                            "content-length": String(reference.bytes), "content-disposition": `attachment; filename="${reference.name}"`,
                            "x-rabiroute-content-sha256": reference.sha256, "x-content-type-options": "nosniff" } };
                    validateApiOperationResult(compiled, result);
                    streamOwnsCleanup = true;
                    return result;
                }
                finally {
                    if (!streamOwnsCleanup)
                        release();
                }
            }
            catch (error) {
                return napcatApiFailure(error);
            }
        } });
    return definitions;
}
