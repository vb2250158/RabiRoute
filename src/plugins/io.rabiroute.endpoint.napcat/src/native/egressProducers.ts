import { napcatNativeEgressDefinitions, nativeEgressVariant } from "./egressDefinitions.js";
import type { IncomingMessage } from "node:http";
import type { MessageEndpointSendVariant, MessageEndpointVariantSendInput, MessageEndpointVariantSendOutcome } from "@rabiroute/plugin-sdk";
import { compileApiContract, type ApiOperationContract } from "@rabiroute/host-api/manager/apiOperationContract";
import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { messageAdapterPolicyFor } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { readExactQqMessage } from "../manager/qqMessageRoutes.js";
import { callNapcatApi, callNapcatManagedAttachment, NapcatApiError, selectNapcatApiInstance, verifyNapcatApiIdentity, type NapcatApiTransportContext } from "../manager/napcatApiTransport.js";
const empty = { type: "object", additionalProperties: false };
const actions = new Set(napcatNativeEgressDefinitions.map(definition => definition.action));
type OriginalSource = {
    kind: "group" | "private";
    targetId: string;
    messageId: string;
};
type Producer = Readonly<{
    action: string;
    variant: MessageEndpointSendVariant;
    send(input: MessageEndpointVariantSendInput): Promise<MessageEndpointVariantSendOutcome>;
}>;
export type NapcatNativeEgressContext = Omit<NapcatApiTransportContext, "local"> & {
    resolveNativeDirectory?(binding: {
        routeId: string;
        instanceId: string;
        botUserId: string;
        onebotHttpUrl: string;
        onebotAccessToken: string;
        fileRef: string;
    }, signal: AbortSignal, authorize: () => void): Promise<{
        nativePath: string;
        name: string;
        snapshotDigest: string;
        assertCurrent(): void;
        release(): void | Promise<void>;
    }>;
};
/** Only the original SDK egress owner invokes these methods, after text/media policy and durable intent admission. */
export function createNapcatNativeEgressProducers(context: NapcatNativeEgressContext): readonly Producer[] {
    return napcatNativeEgressDefinitions.map(definition => {
        const { action, family } = definition;
        const albumComment = family === "album-comment";
        const onlineFile = family === "online-file";
        const albumImage = family === "album-image";
        const onlineFolder = family === "online-folder";
        const sourceForward = family === "source-forward";
        const flash = family === "flash";
        const variant = nativeEgressVariant(definition);
        const { operation, paramsSchema, dataSchema } = variant;
        const guardContract: ApiOperationContract = {
            operationId: `napcat.internal.${operation}`, contractVersion: "1.0.0", method: "POST", pathTemplate: `/internal/${operation}`,
            exposure: "internal", transport: "http", description: "Compile-only closed egress parameter validation; this operation is never registered as an HTTP API.",
            effects: { mode: "write", description: "Original agent.send owns outgoing text policy, media policy, authorization and durable receipts." },
            recovery: { strategy: "original-receipt", description: "Only the original outbox decides whether the same business intent can execute." },
            validators: [{ id: "napcat.egress.closed-input", description: "The selected native producer validates the closed original public data and target schemas." }],
            request: { path: empty, query: empty, headers: { type: "object" }, body: {
                    kind: "json", maxBytes: qqReadSettings.jsonBytes, schema: { type: "object", additionalProperties: false, required: ["params", "data"], properties: {
                            params: paramsSchema, data: dataSchema
                        } }
                } }, responses: { "200": { mediaType: "application/json", schema: {} } }
        };
        const validator = compileApiContract({ contract: guardContract }).bodyValidator!;
        return {
            action, variant,
            async send(input) {
                if (!validator({ params: input.target, data: input.data })) {
                    throw new NapcatApiError(400, "QQ_NATIVE_EGRESS_INPUT_INVALID");
                }
                const target = input.target.target;
                const groupId = input.target.groupId;
                const userId = input.target.userId;
                if (target === "group" ? !groupId || userId !== undefined : !userId || groupId !== undefined) {
                    throw new NapcatApiError(400, "QQ_NATIVE_EGRESS_TARGET_INVALID");
                }
                const route = context.route(input.gatewayId);
                const assertEgressCurrent = () => {
                    context.assertCurrent?.();
                    const currentRoute = context.route(input.gatewayId);
                    const profile = currentRoute?.routeProfiles?.find(value => value.id === input.routeId);
                    const ownsRoute = profile ? profile.enabled !== false
                        : (currentRoute?.routeProfiles?.length ?? 0) <= 1 && [currentRoute?.id, currentRoute?.configName].includes(input.routeId);
                    if (!currentRoute || currentRoute !== route || !ownsRoute) {
                        throw new NapcatApiError(409, "QQ_NATIVE_EGRESS_ROUTE_CHANGED");
                    }
                    const policy = messageAdapterPolicyFor(currentRoute, "napcat");
                    const media = variant.readMedia?.(input.data);
                    const mediaKinds = [...(media?.kinds ?? []), ...(media?.attachments?.map(attachment => attachment.kind) ?? [])];
                    const requiredOutputs = [...mediaKinds, ...(variant.readText(input.data) ? ["text" as const] : [])];
                    if (!policy.outputEnabled || requiredOutputs.some(kind => !policy.supportedOutputs.includes(kind))) {
                        throw new NapcatApiError(403, "QQ_NATIVE_EGRESS_OUTPUT_DISABLED");
                    }
                };
                assertEgressCurrent();
                const internalContext: NapcatApiTransportContext = { ...context, local: () => true, assertCurrent: assertEgressCurrent };
                const request = { headers: {} } as IncomingMessage;
                const signal = AbortSignal.timeout(getTimeoutMs("qq.nativeEgress", 60000));
                const selection = selectNapcatApiInstance(internalContext, request, input.gatewayId, String(input.target.instanceId), signal);
                const identity = await verifyNapcatApiIdentity(internalContext, selection, signal);
                const destination = target === "group" ? { group_id: groupId } : { user_id: userId };
                let parameters: Record<string, unknown>;
                let result: unknown;
                let nativeActionCompleted = false;
                if (action === "_send_group_notice") {
                    parameters = {
                        group_id: groupId, content: input.data.content, pinned: input.data.pinned ?? 0,
                        type: 1, confirm_required: input.data.confirmRequired ?? 1,
                        is_show_edit_card: input.data.showEditCard ?? 0, tip_window_type: input.data.tipWindowType ?? 0
                    };
                }
                else if (action === "send_group_ai_record") {
                    parameters = { group_id: groupId, character: input.data.character, text: input.data.text };
                }
                else if (albumComment) {
                    parameters = { group_id: groupId, album_id: input.data.albumId, lloc: input.data.imageId, content: input.data.content };
                }
                else if (onlineFolder) {
                    if (!context.resolveNativeDirectory) {
                        throw new NapcatApiError(503, "QQ_NATIVE_DIRECTORY_OWNER_UNAVAILABLE");
                    }
                    const directory = await context.resolveNativeDirectory({ routeId: selection.routeId, instanceId: selection.instanceId,
                        botUserId: selection.botUserId, onebotHttpUrl: selection.httpUrl, onebotAccessToken: selection.accessToken,
                        fileRef: String(input.data.directoryRef) }, signal, selection.assertCurrent);
                    try {
                        directory.assertCurrent();
                        const native = await callNapcatApi(internalContext, selection, action, {
                            user_id: userId, folder_path: directory.nativePath, folder_name: input.data.folderName ?? directory.name
                        }, actions, signal);
                        directory.assertCurrent();
                        await verifyNapcatApiIdentity(internalContext, selection, signal);
                        if (!native || typeof native !== "object" || (native as {
                            result?: unknown;
                        }).result !== 0) {
                            throw new NapcatApiError(503, "QQ_NATIVE_EGRESS_ACK_INVALID");
                        }
                        return { acknowledged: true };
                    }
                    finally {
                        await directory.release();
                    }
                }
                else if (onlineFile || albumImage) {
                    const attachment = input.attachments?.length === 1 ? input.attachments[0] : undefined;
                    if (!attachment || attachment.kind !== (albumImage ? "image" : "file")) {
                        throw new NapcatApiError(422, "QQ_NATIVE_EGRESS_MANAGED_ATTACHMENT_REQUIRED");
                    }
                    const managedFile = { path: attachment.path, sha256: (input.data.attachment as {
                            fileSha256: string;
                        }).fileSha256 };
                    if (albumImage) {
                        result = await callNapcatManagedAttachment(internalContext, selection, { action: "upload_image_to_qun_album",
                            groupId: String(groupId), albumId: String(input.data.albumId), albumName: String(input.data.albumName) }, managedFile, signal);
                        nativeActionCompleted = true;
                        parameters = {};
                    }
                    else {
                        const nativeFile = await callNapcatManagedAttachment(internalContext, selection, { action: "download_file" }, managedFile, signal);
                        const nativePath = nativeFile && typeof nativeFile === "object" ? (nativeFile as {
                            file?: unknown;
                        }).file : undefined;
                        if (typeof nativePath !== "string" || !nativePath || /[\x00-\x1f\x7f]/.test(nativePath)) {
                            throw new NapcatApiError(503, "QQ_NATIVE_EGRESS_STAGED_FILE_UNAVAILABLE");
                        }
                        parameters = { user_id: userId, file_path: nativePath, file_name: attachment.fileName };
                    }
                }
                else if (sourceForward || flash) {
                    const source = input.data.source as OriginalSource;
                    if (sourceForward && source.kind !== (action === "forward_friend_single_msg" ? "private" : "group")) {
                        throw new NapcatApiError(400, "QQ_NATIVE_EGRESS_SOURCE_KIND_INVALID");
                    }
                    const message = await readExactQqMessage({ endpoint: selection, kind: source.kind, target: source.targetId,
                        messageId: source.messageId, signal, current: selection.assertCurrent, transport: context.transport });
                    const segments = message.message;
                    if (!Array.isArray(segments)) {
                        throw new NapcatApiError(422, "QQ_NATIVE_EGRESS_SOURCE_SHAPE_UNSUPPORTED");
                    }
                    if (flash) {
                        const candidates = segments.filter(segment => segment?.type === "flashtransfer");
                        const filesetId = candidates.length === 1 ? candidates[0]?.data?.fileSetId : undefined;
                        if (typeof filesetId !== "string" || !filesetId || filesetId.length > 4096 || /[\x00-\x1f\x7f]/.test(filesetId)) {
                            throw new NapcatApiError(422, "QQ_NATIVE_EGRESS_FLASH_SOURCE_UNAVAILABLE");
                        }
                        parameters = { ...destination, fileset_id: filesetId };
                    }
                    else {
                        let sourceText = "";
                        const kinds = new Set<string>();
                        for (const segment of segments) {
                            if (segment?.type === "text" && typeof segment.data?.text === "string") {
                                sourceText += segment.data.text;
                            }
                            else if (segment?.type === "image" || segment?.type === "record" || segment?.type === "file") {
                                kinds.add(segment.type === "record" ? "voice" : segment.type);
                            }
                            else {
                                throw new NapcatApiError(422, "QQ_NATIVE_EGRESS_SOURCE_SHAPE_UNSUPPORTED");
                            }
                        }
                        const declaredKinds = input.data.mediaKinds as string[];
                        if (sourceText !== input.data.text || JSON.stringify([...kinds].sort()) !== JSON.stringify([...declaredKinds].sort())) {
                            throw new NapcatApiError(409, "QQ_NATIVE_EGRESS_SOURCE_SNAPSHOT_CHANGED");
                        }
                        parameters = { ...destination, message_id: source.messageId };
                    }
                }
                else {
                    parameters = {
                        ...destination, message_type: target,
                        messages: (input.data.nodes as string[]).map(value => ({ type: "node", data: {
                                user_id: selection.botUserId, nickname: String(identity.nickname || selection.botUserId),
                                content: [{ type: "text", data: { text: value } }]
                            } }))
                    };
                }
                if (!nativeActionCompleted) {
                    result = await callNapcatApi(internalContext, selection, action, parameters, actions, signal);
                }
                await verifyNapcatApiIdentity(internalContext, selection, signal);
                if (action === "_send_group_notice" || sourceForward) {
                    if (result !== null && result !== undefined) {
                        throw new NapcatApiError(503, "QQ_NATIVE_EGRESS_ACK_INVALID");
                    }
                    return { acknowledged: true };
                }
                if (flash) {
                    if (!result || typeof result !== "object" || (result as {
                        errCode?: unknown;
                    }).errCode !== 0) {
                        throw new NapcatApiError(503, "QQ_NATIVE_EGRESS_ACK_INVALID");
                    }
                    return { acknowledged: true };
                }
                if (onlineFile) {
                    if (!result || typeof result !== "object" || (result as {
                        result?: unknown;
                    }).result !== 0) {
                        throw new NapcatApiError(503, "QQ_NATIVE_EGRESS_ACK_INVALID");
                    }
                    return { acknowledged: true };
                }
                if (albumComment || albumImage) {
                    // The published action result is Any. Only the OneBot status=ok/retcode=0 acknowledgement is claimed;
                    // opaque platform data is not interpreted as proof of visible publication or persisted album contents.
                    return { acknowledged: true };
                }
                if (action === "send_group_ai_record") {
                    if (!result || typeof result !== "object" || (result as {
                        message_id?: unknown;
                    }).message_id !== 0) {
                        throw new NapcatApiError(503, "QQ_NATIVE_EGRESS_ACK_INVALID");
                    }
                    return { acknowledged: true };
                }
                const messageId = result && typeof result === "object" ? (result as {
                    message_id?: unknown;
                }).message_id : undefined;
                if ((typeof messageId !== "string" && typeof messageId !== "number") || !/^-?[1-9][0-9]*$/.test(String(messageId))) {
                    throw new NapcatApiError(503, "QQ_NATIVE_EGRESS_MESSAGE_ID_INVALID");
                }
                return { messageId: String(messageId) };
            }
        };
    });
}
