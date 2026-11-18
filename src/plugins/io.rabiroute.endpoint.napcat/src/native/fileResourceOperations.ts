import { createHash } from "node:crypto";
import type { MessageEndpointManagedAttachmentPort } from "@rabiroute/plugin-sdk";
import { compileApiContract, type ApiOperationDefinition, type ApiOperationContract } from "@rabiroute/host-api/manager/apiOperationContract";
import { executeDurableDelivery } from "@rabiroute/host-api/manager/durableDeliveryIdempotency";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import { callNapcatApi, callNapcatManagedAttachment, uploadNapcatManagedFileStream, selectNapcatApiInstance, verifyNapcatApiIdentity, NapcatApiError, napcatApiFailure, type NapcatApiTransportContext } from "../manager/napcatApiTransport.js";
import { NapcatNativeFileHandles, type NativeFileReference } from "./fileHandles.js";
import type { NativeResourceObjects } from "./artifactObjects.js";
import type { NativeProtectedResourceObjects } from "./protectedObjects.js";
import { nativeFileResourceParameters, nativeFileReferenceSchema, type ManagedNativeAttachmentReference } from "./fileResourceDefinitions.js";
export type NapcatManagedAttachmentReader = MessageEndpointManagedAttachmentPort;
export type NapcatFileResourceContext = NapcatApiTransportContext & {
    rootDir: string;
    readOnly(): boolean;
    resourceObjects: NativeResourceObjects;
    protectedResourceObjects: NativeProtectedResourceObjects;
    withManagedAttachment: NapcatManagedAttachmentReader;
};
type Action = keyof typeof nativeFileResourceParameters;
type Parameters = {
    attachment?: ManagedNativeAttachmentReference;
    attachments?: Array<ManagedNativeAttachmentReference | {
        nativeFile: Pick<NativeFileReference, "id" | "action" | "deliveryId">;
    }>;
    name?: string;
    fileRetentionMs?: number;
};
const actions: readonly Action[] = ["download_file", "upload_file_stream", "create_flash_task"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function stableValue(value: unknown): unknown {
    if (Array.isArray(value))
        return value.map(stableValue);
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, stableValue(child)]));
    return value;
}
/** The host injects its existing managed upload/plan-attachment lease. It never accepts a caller filesystem path. */
export function createNapcatFileResourceOperations(context: NapcatFileResourceContext): readonly ApiOperationDefinition[] {
    const handles = new NapcatNativeFileHandles(context.protectedResourceObjects);
    return actions.map(action => {
        const empty = { type: "object", additionalProperties: false };
        const resultSchema = action === "create_flash_task"
            ? { type: "object", additionalProperties: false, required: ["acknowledged", "nativeContractEquivalent", "fileCount"], properties: {
                    acknowledged: { const: true }, nativeContractEquivalent: { const: false }, fileCount: { type: "integer", minimum: 1 }
                } }
            : nativeFileReferenceSchema;
        const contract: ApiOperationContract = {
            operationId: `agent.qq.onebot.${action}`, aliases: [`agent.qq.onebot.${action}_async`, `agent.qq.onebot.${action}_rate_limited`],
            contractVersion: "1.0.0", method: "POST", pathTemplate: `/api/agent/qq/onebot/${action}`, exposure: "public", transport: "http",
            description: action === "create_flash_task"
                ? "Create a native flash upload task from original leased managed attachments. Native result0 proves task initiation only; the opaque native task result is not interpreted as a fileset ID or completed cloud upload. Native paths stay request-local."
                : "Materialize one original leased managed attachment through the actual fixed native file API. Only an opaque resource reference is public; its native path remains with the original shared cache owner. The selected native cache can later remove the file. This is not the unrestricted native URL/path/raw-chunk contract.",
            request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "json", maxBytes: qqReadSettings.jsonBytes, schema: {
                        type: "object", additionalProperties: false, required: ["routeId", "instanceId", "deliveryId", "params"], properties: {
                            routeId: { type: "string", minLength: 1, maxLength: 256 }, instanceId: { type: "string", minLength: 1, maxLength: 256 },
                            deliveryId: { type: "string", minLength: 1, maxLength: 200 }, params: nativeFileResourceParameters[action],
                            timeoutMs: { type: "integer", minimum: 1, maximum: 2147483647 }
                        }
                    } } },
            responses: { "200": { mediaType: "application/json", schema: { type: "object", additionalProperties: false, required: ["code", "data", "delivery"], properties: {
                            code: { const: 0 }, data: resultSchema, delivery: { type: "object" }
                        } } }, "202": { mediaType: "application/json", schema: { type: "object", required: ["code", "delivery"], properties: { code: { const: 0 }, delivery: { type: "object" } } } },
                default: { mediaType: "application/json", schema: { type: "object", required: ["code", "errorCode"], properties: { code: { const: -1 }, errorCode: { type: "string" } } } } },
            effects: { mode: "external-mutation", description: "The original managed attachment lease verifies source access; the native platform owns staging/cloud-task effects. The original durable receipt is the only business ledger." },
            recovery: { strategy: "original-receipt-and-native-file-reference", description: "Only an already committed original native-file resource reference can recover a lost staging acknowledgement. Missing references and unknown flash-task outcomes never authorize re-upload, reset or regeneration." },
            validators: [{ id: "napcat.managed-native-file", description: "Original request/attachment permissions, SHA/length-checked streaming, exact configured binding/actual QQ, fixed native protocols and shared-cache metadata ownership." }]
        };
        const validator = compileApiContract({ contract }).bodyValidator!;
        return { contract, async handler(input) {
                const controller = new AbortController();
                const abort = () => controller.abort(input.signal?.reason);
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    if (!validator(input.body))
                        throw new NapcatApiError(400, "QQ_NATIVE_FILE_INPUT_INVALID");
                    if (context.readOnly())
                        throw new NapcatApiError(403, "QQ_API_READ_ONLY");
                    const body = input.body as {
                        routeId: string;
                        instanceId: string;
                        deliveryId: string;
                        params: Parameters;
                        timeoutMs?: number;
                    };
                    input.signal?.addEventListener("abort", abort, { once: true });
                    if (input.signal?.aborted)
                        abort();
                    timer = setTimeout(() => controller.abort(), body.timeoutMs ?? getTimeoutMs("qq.nativeFile", 60000));
                    const selection = selectNapcatApiInstance(context, input.request, body.routeId, body.instanceId, controller.signal);
                    const requestDigest = hash(JSON.stringify(stableValue(body.params)));
                    await verifyNapcatApiIdentity(context, selection, controller.signal);
                    const find = () => action === "create_flash_task" ? Promise.resolve(undefined)
                        : handles.findOriginal(selection, action, body.deliveryId, requestDigest);
                    const outcome = await executeDurableDelivery({ rootDir: context.rootDir, namespace: "napcat-onebot-actions", deliveryId: body.deliveryId,
                        payload: { action, routeId: body.routeId, instanceId: body.instanceId, botUserId: selection.botUserId, params: body.params },
                        audit: { action, routeId: body.routeId, instanceId: body.instanceId, botUserId: selection.botUserId }, requestAuthority: selection.assertCurrent,
                        recoverExistingUncertain: action !== "create_flash_task",
                        recover: async () => {
                            const original = await find();
                            return original ? { state: "completed", result: original } : { state: "uncertain", reason: "Original native file reference is missing; native staging is never repeated." };
                        },
                        deliver: async () => {
                            const original = await find();
                            if (original)
                                return original;
                            await verifyNapcatApiIdentity(context, selection, controller.signal);
                            if (action === "create_flash_task") {
                                const nativePaths: string[] = [];
                                for (const reference of body.params.attachments!) {
                                    if ("nativeFile" in reference) {
                                        const file = await handles.read(selection, reference.nativeFile);
                                        nativePaths.push(file.nativePath);
                                        continue;
                                    }
                                    const nativePath = await context.withManagedAttachment(input.request, reference, selection.assertCurrent, async (file) => {
                                        const result = await callNapcatManagedAttachment(context, selection, { action: "download_file" }, { path: file.path, sha256: file.sha256 }, controller.signal);
                                        const native = result as {
                                            file?: unknown;
                                        } | null;
                                        if (typeof native?.file !== "string" || !native.file || /[\x00-\x1f\x7f]/.test(native.file))
                                            throw new NapcatApiError(503, "QQ_NATIVE_FILE_RESULT_INVALID");
                                        return native.file;
                                    });
                                    nativePaths.push(nativePath);
                                }
                                const native = await callNapcatApi(context, selection, action, { files: nativePaths, name: body.params.name ?? "" }, new Set([action]), controller.signal);
                                if (!native || typeof native !== "object" || (native as {
                                    result?: unknown;
                                }).result !== 0)
                                    throw new NapcatApiError(503, "QQ_NATIVE_FLASH_TASK_UNCONFIRMED");
                                await verifyNapcatApiIdentity(context, selection, controller.signal);
                                return { acknowledged: true, nativeContractEquivalent: false, fileCount: nativePaths.length };
                            }
                            return context.withManagedAttachment(input.request, body.params.attachment!, selection.assertCurrent, async (file) => {
                                let nativePath: string;
                                if (action === "download_file") {
                                    const native = await callNapcatManagedAttachment(context, selection, { action }, { path: file.path, sha256: file.sha256 }, controller.signal) as {
                                        file?: unknown;
                                    } | null;
                                    if (typeof native?.file !== "string" || !native.file || /[\x00-\x1f\x7f]/.test(native.file))
                                        throw new NapcatApiError(503, "QQ_NATIVE_FILE_RESULT_INVALID");
                                    nativePath = native.file;
                                }
                                else {
                                    const native = await uploadNapcatManagedFileStream(context, selection, {
                                        streamId: hash(JSON.stringify([body.routeId, body.instanceId, selection.botUserId, action, body.deliveryId])),
                                        chunkBytes: Math.max(1, Math.min(65535, Math.floor((qqReadSettings.jsonBytes - 4096) * 3 / 4))),
                                        fileRetentionMs: body.params.fileRetentionMs ?? 300000
                                    }, { path: file.path, sha256: file.sha256 }, controller.signal);
                                    nativePath = native.nativePath;
                                }
                                await verifyNapcatApiIdentity(context, selection, controller.signal);
                                const resource = await handles.put(selection, action, body.deliveryId, { nativePath, requestDigest,
                                    bytes: file.bytes, sha256: file.sha256.toLowerCase(), name: file.fileName });
                                await verifyNapcatApiIdentity(context, selection, controller.signal);
                                return resource;
                            });
                        }
                    });
                    selection.assertCurrent();
                    await verifyNapcatApiIdentity(context, selection, controller.signal);
                    if (outcome.state === "conflict")
                        throw new NapcatApiError(409, "QQ_API_DELIVERY_CONFLICT");
                    if (outcome.state !== "completed")
                        return { status: 202, body: { code: 0, delivery: { deliveryId: outcome.deliveryId, state: outcome.state, retryable: false } } };
                    return { status: 200, body: { code: 0, data: outcome.result, delivery: { deliveryId: outcome.deliveryId, state: outcome.state, duplicate: outcome.duplicate } } };
                }
                catch (error) {
                    return napcatApiFailure(error);
                }
                finally {
                    clearTimeout(timer);
                    input.signal?.removeEventListener("abort", abort);
                }
            } };
    });
}
