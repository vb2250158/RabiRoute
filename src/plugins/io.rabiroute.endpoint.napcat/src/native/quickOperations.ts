import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { MessageEndpointSendVariant, MessageEndpointVariantSendInput, MessageEndpointAgentSendProducer } from "@rabiroute/plugin-sdk";
import { compileApiContract, type ApiOperationDefinition, type ApiOperationInput, type ApiOperationResult } from "@rabiroute/host-api/manager/apiOperationContract";
import { executeDurableDelivery } from "@rabiroute/host-api/manager/durableDeliveryIdempotency";
import { messageAdapterPolicyFor } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { readExactQqMessage } from "../manager/qqMessageRoutes.js";
import { callNapcatApi, selectNapcatApiInstance, verifyNapcatApiIdentity, NapcatApiError, napcatApiFailure, type NapcatApiTransportContext, type NapcatApiSelection } from "../manager/napcatApiTransport.js";
import { readNapcatQuickRequestContext, type QuickOperationPrivateObjects } from "./quickOperationContexts.js";
type Row = Record<string, unknown>;
export type QuickMessageSource = {
    kind: "group" | "private";
    targetId: string;
    messageId: string;
};
export type QuickNativeAction = "delete_msg" | "set_group_kick" | "set_group_ban" | "set_friend_add_request" | "set_group_add_request";
const numericId = { type: "string", pattern: "^[1-9][0-9]{0,15}$" };
const messageId = { type: "string", pattern: "^-?[0-9]{1,20}$" };
const text = { type: "string", minLength: 1, maxLength: 65536 };
const short = { type: "string", minLength: 1, maxLength: 256 };
const empty = { type: "object", additionalProperties: false };
const sourceSchema = { type: "object", additionalProperties: false, required: ["kind", "targetId", "messageId"], properties: {
        kind: { enum: ["group", "private"] }, targetId: numericId, messageId
    } };
const digest = (value: unknown) => {
    const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable)
        : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable((item as Row)[key])])) : item;
    return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
};
export const quickOperationChildId = (parent: string, effect: string) => `quick-${digest([parent, effect])}`;
function sourceSender(message: Row): string {
    const sender = message.sender && typeof message.sender === "object" ? message.sender as Row : {};
    const id = String(sender.user_id ?? message.user_id ?? "");
    if (sender.user_id !== undefined && message.user_id !== undefined && String(sender.user_id) !== String(message.user_id)) {
        throw new NapcatApiError(503, "QQ_QUICK_MESSAGE_SENDER_INCONSISTENT");
    }
    if (!/^[1-9]\d{0,15}$/.test(id))
        throw new NapcatApiError(503, "QQ_QUICK_MESSAGE_SENDER_UNAVAILABLE");
    return id;
}
function sourceMessageId(message: Row): string {
    const id = String(message.message_id ?? "");
    if (!/^-?\d{1,20}$/.test(id) || /^-?0+$/.test(id))
        throw new NapcatApiError(503, "QQ_QUICK_MESSAGE_ID_UNAVAILABLE");
    return id;
}
async function readSource(context: NapcatApiTransportContext, selection: NapcatApiSelection, source: QuickMessageSource, signal: AbortSignal) {
    await verifyNapcatApiIdentity(context, selection, signal);
    return readExactQqMessage({ endpoint: selection, kind: source.kind, target: source.targetId, messageId: source.messageId,
        signal, current: selection.assertCurrent, transport: context.transport });
}
/** Fixed outbox producer; caller text participates in the original language/length policy. */
export function createNapcatQuickReplyProducer(context: NapcatApiTransportContext) {
    const paramsSchema = { type: "object", additionalProperties: false, required: ["target", "instanceId", "source", "senderUserId"], properties: {
            target: { enum: ["group", "private"] }, instanceId: short, groupId: numericId, userId: numericId,
            source: sourceSchema, senderUserId: numericId
        } };
    const dataSchema = { type: "object", additionalProperties: false, required: ["text", "atSender"], properties: { text, atSender: { type: "boolean" } } };
    const variant: MessageEndpointSendVariant = {
        type: "napcat.quick-reply", contractVersion: 1, operation: "sendQuickReply", receiptMode: "message",
        description: "Plain-text quick reply to a real selected original message, with native group quote and optional actual-sender mention. CQ media codes use the existing managed-media agent.send variants.",
        paramsSchema, dataSchema, readText: data => String(data.text)
    };
    const guard = compileApiContract({ contract: {
            operationId: "napcat.internal.quick-reply", contractVersion: "1.0.0", method: "POST", pathTemplate: "/_napcat/quick-reply",
            exposure: "internal", transport: "http", description: variant.description,
            request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "json", maxBytes: qqReadSettings.jsonBytes, schema: { type: "object", additionalProperties: false, required: ["params", "data"], properties: { params: paramsSchema, data: dataSchema } } } },
            responses: { default: { mediaType: "application/json", schema: { type: "object" } } }, effects: { mode: "read", description: "Internal input validation only." }, recovery: { strategy: "none", description: "No effect." }, validators: []
        } }).bodyValidator!;
    return { variant, async send(input: MessageEndpointVariantSendInput) {
            if (!guard({ params: input.target, data: input.data }))
                throw new NapcatApiError(400, "QQ_QUICK_REPLY_INVALID");
            const route = context.route(input.gatewayId), source = input.target.source as QuickMessageSource;
            const target = input.target.target;
            if (source.kind !== target || source.targetId !== String(target === "group" ? input.target.groupId : input.target.userId)
                || (target === "group" ? input.target.userId !== undefined : input.target.groupId !== undefined)) {
                throw new NapcatApiError(400, "QQ_QUICK_REPLY_TARGET_INVALID");
            }
            const assertCurrent = () => {
                context.assertCurrent?.();
                const current = context.route(input.gatewayId);
                const profile = current?.routeProfiles?.find(item => item.id === input.routeId);
                const ownsRoute = profile ? profile.enabled !== false : (current?.routeProfiles?.length ?? 0) <= 1 && [current?.id, current?.configName].includes(input.routeId);
                if (!current || current !== route || !ownsRoute)
                    throw new NapcatApiError(409, "QQ_QUICK_REPLY_ROUTE_CHANGED");
                const policy = messageAdapterPolicyFor(current, "napcat");
                if (!policy.outputEnabled || !policy.supportedOutputs.includes("text"))
                    throw new NapcatApiError(403, "QQ_QUICK_REPLY_OUTPUT_DISABLED");
            };
            assertCurrent();
            const internal = { ...context, local: () => true, assertCurrent };
            const signal = AbortSignal.timeout(qqReadSettings.readTimeoutMs);
            const selection = selectNapcatApiInstance(internal, { headers: {} } as IncomingMessage, input.gatewayId, String(input.target.instanceId), signal);
            const original = await readSource(internal, selection, source, signal);
            const senderUserId = sourceSender(original as Row);
            if (senderUserId !== input.target.senderUserId)
                throw new NapcatApiError(409, "QQ_QUICK_REPLY_SOURCE_CHANGED");
            const segments: Row[] = [];
            if (source.kind === "group") {
                segments.push({ type: "reply", data: { id: sourceMessageId(original as Row) } });
                if (input.data.atSender)
                    segments.push({ type: "at", data: { qq: senderUserId } });
            }
            segments.push({ type: "text", data: { text: input.data.text } });
            const action = source.kind === "group" ? "send_group_msg" : "send_private_msg";
            const result = await callNapcatApi(internal, selection, action, { [source.kind === "group" ? "group_id" : "user_id"]: source.targetId, message: segments, auto_escape: true }, new Set([action]), signal) as Row;
            const id = String(result?.message_id ?? "");
            if (!/^-?\d{1,20}$/.test(id) || /^-?0+$/.test(id))
                throw new NapcatApiError(503, "QQ_QUICK_REPLY_MESSAGE_ID_REQUIRED");
            return { messageId: id };
        } };
}
export type NapcatQuickOperationContext = NapcatApiTransportContext & {
    rootDir: string;
    readOnly(): boolean;
    protectedResourceObjects: QuickOperationPrivateObjects;
    submitAgentSendVariant: MessageEndpointAgentSendProducer;
    invokeNativeAction(action: QuickNativeAction, input: ApiOperationInput): Promise<ApiOperationResult>;
};
/** Sequential child effects retain their original outbox/native receipts, never the upstream fire-and-forget quick handler. */
export function createNapcatQuickOperation(context: NapcatQuickOperationContext): ApiOperationDefinition {
    const operationSchema = { type: "object", additionalProperties: false, minProperties: 1, properties: { reply: text, auto_escape: { type: "boolean" }, at_sender: { type: "boolean" }, delete: { type: "boolean" }, kick: { type: "boolean" }, ban: { type: "boolean" }, ban_duration: { type: "integer", minimum: 0 }, approve: { type: "boolean" }, remark: { type: "string", maxLength: 4096 }, reason: { type: "string", maxLength: 4096 } } };
    const contract = {
        operationId: "agent.qq.onebot.handle_quick_operation", aliases: ["agent.qq.onebot..handle_quick_operation", "agent.qq.onebot..handle_quick_operation_async", "agent.qq.onebot..handle_quick_operation_rate_limited"], contractVersion: "1.0.0", method: "POST" as const, pathTemplate: "/api/agent/qq/onebot/.handle_quick_operation", exposure: "public" as const, transport: "http" as const,
        description: "Source-bound quick operations. Messages use original exact reads; request flags come only from sealed original ingress refs. Replies enter the original agent.send outbox; other effects use fixed original native owners. Composite partial/unknown results do not automatically replay. This is a typed compatibility shape, not caller-provided native context or arbitrary CQ segments.",
        request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "json" as const, maxBytes: qqReadSettings.jsonBytes, schema: { type: "object", additionalProperties: false, required: ["routeId", "instanceId", "deliveryId", "source", "operation"], properties: { routeId: short, instanceId: short, deliveryId: short, source: { anyOf: [sourceSchema, { type: "object", additionalProperties: false, required: ["eventRef"], properties: { eventRef: { type: "string", pattern: "^[a-f0-9]{64}$" } } }] }, operation: operationSchema, sender: { type: "object", additionalProperties: false, required: ["agentType", "sessionId"], properties: { agentType: short, sessionId: short } }, styleValidation: { enum: [0, 1, null] }, messageLengthConfirmation: { type: ["string", "null"] } } } } },
        responses: { default: { mediaType: "application/json", schema: { type: "object" } } },
        effects: { mode: "write" as const, description: "Fixed original outbox/native owners and original per-effect receipts." },
        recovery: { strategy: "original-quick-parent-and-child-receipts", description: "Keep parent and deterministic child delivery IDs. Unknown or partial execution is not replayed." }, validators: [{ id: "napcat.quick.original-source", description: "Original source read or sealed ingress provenance, original sender/outbox and exact native child owners." }]
    };
    const validator = compileApiContract({ contract }).bodyValidator!;
    return { contract, async handler(input) {
            try {
                if (input.url.pathname !== contract.pathTemplate || input.url.search || Object.keys(input.path ?? {}).length || Object.keys(input.query ?? {}).length || !validator(input.body))
                    throw new NapcatApiError(400, "QQ_QUICK_INPUT_INVALID");
                if (context.readOnly())
                    throw new NapcatApiError(403, "QQ_QUICK_READ_ONLY");
                const body = input.body as {
                    routeId: string;
                    instanceId: string;
                    deliveryId: string;
                    source: QuickMessageSource | {
                        eventRef: string;
                    };
                    operation: Row;
                    sender?: {
                        agentType: string;
                        sessionId: string;
                    };
                    styleValidation?: 0 | 1 | null;
                    messageLengthConfirmation?: string | null;
                };
                const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(qqReadSettings.readTimeoutMs)]) : AbortSignal.timeout(qqReadSettings.readTimeoutMs);
                const selection = selectNapcatApiInstance(context, input.request, body.routeId, body.instanceId, signal), operation = body.operation;
                const steps: Array<{
                    effect: string;
                    run: (id: string) => Promise<ApiOperationResult>;
                }> = [];
                const native = (effect: string, action: QuickNativeAction, params: Row) => steps.push({ effect, run: id => context.invokeNativeAction(action, { ...input, signal, body: { routeId: body.routeId, instanceId: body.instanceId, deliveryId: id, params }, url: new URL(`/api/agent/qq/onebot/${action}`, input.url), path: {}, query: {} }) });
                if ("eventRef" in body.source) {
                    if (Object.keys(operation).some(key => !["approve", "remark", "reason"].includes(key)) || typeof operation.approve !== "boolean")
                        throw new NapcatApiError(400, "QQ_QUICK_REQUEST_OPERATION_INVALID");
                    await verifyNapcatApiIdentity(context, selection, signal);
                    const request = await readNapcatQuickRequestContext(context.protectedResourceObjects, selection, body.source.eventRef, selection.assertCurrent, signal);
                    if (request.request_type === "friend") {
                        if (operation.reason !== undefined)
                            throw new NapcatApiError(400, "QQ_QUICK_REQUEST_OPERATION_INVALID");
                        native("approve", "set_friend_add_request", { eventRef: body.source.eventRef, approve: operation.approve, ...operation.remark !== undefined ? { remark: operation.remark } : {} });
                    }
                    else {
                        if (operation.remark !== undefined)
                            throw new NapcatApiError(400, "QQ_QUICK_REQUEST_OPERATION_INVALID");
                        native("approve", "set_group_add_request", { eventRef: body.source.eventRef, sub_type: request.sub_type, approve: operation.approve, ...operation.reason !== undefined ? { reason: operation.reason } : {} });
                    }
                }
                else {
                    if (Object.keys(operation).some(key => !["reply", "auto_escape", "at_sender", "delete", "kick", "ban", "ban_duration"].includes(key)))
                        throw new NapcatApiError(400, "QQ_QUICK_MESSAGE_OPERATION_INVALID");
                    if (body.source.kind === "private" && (operation.kick || operation.ban || operation.ban_duration !== undefined))
                        throw new NapcatApiError(400, "QQ_QUICK_GROUP_REQUIRED");
                    if (operation.ban === true && operation.ban_duration === undefined)
                        throw new NapcatApiError(400, "QQ_QUICK_BAN_DURATION_REQUIRED");
                    if (operation.ban_duration !== undefined && operation.ban !== true)
                        throw new NapcatApiError(400, "QQ_QUICK_BAN_REQUIRED");
                    if (operation.reply !== undefined && operation.auto_escape !== true && String(operation.reply).includes("[CQ:"))
                        throw new NapcatApiError(422, "QQ_QUICK_CQ_REQUIRES_MANAGED_SEND_VARIANT");
                    const original = await readSource(context, selection, body.source, signal), senderUserId = sourceSender(original as Row), source = body.source;
                    if (operation.reply !== undefined) {
                        if (!body.sender)
                            throw new NapcatApiError(400, "QQ_QUICK_REPLY_SENDER_REQUIRED");
                        steps.push({ effect: "reply", run: async (id) => {
                                const result = await context.submitAgentSendVariant(input.request, { deliveryId: id, sender: body.sender!, routeId: body.routeId, channel: "napcat", params: { target: source.kind, instanceId: body.instanceId, [source.kind === "group" ? "groupId" : "userId"]: source.targetId, source, senderUserId }, payload: { type: "napcat.quick-reply", data: { text: operation.reply, atSender: operation.at_sender === true } }, styleValidation: body.styleValidation, messageLengthConfirmation: body.messageLengthConfirmation }, selection.assertCurrent);
                                return { status: result.statusCode, body: result.body };
                            } });
                    }
                    if (operation.delete === true)
                        native("delete", "delete_msg", { message_id: sourceMessageId(original as Row) });
                    if (operation.kick === true)
                        native("kick", "set_group_kick", { group_id: source.targetId, user_id: senderUserId });
                    if (operation.ban === true)
                        native("ban", "set_group_ban", { group_id: source.targetId, user_id: senderUserId, duration: operation.ban_duration });
                }
                if (!steps.length)
                    throw new NapcatApiError(400, "QQ_QUICK_EFFECT_REQUIRED");
                const effects: Array<{
                    effect: string;
                    deliveryId: string;
                    state: string;
                }> = [];
                const outcome = await executeDurableDelivery({ rootDir: context.rootDir, namespace: "napcat-onebot-actions", deliveryId: body.deliveryId, payload: { action: ".handle_quick_operation", routeId: body.routeId, instanceId: body.instanceId, botUserId: selection.botUserId, source: body.source, operationDigest: digest(operation), sender: body.sender }, audit: { action: "handle_quick_operation", routeId: body.routeId, instanceId: body.instanceId, botUserId: selection.botUserId }, requestAuthority: selection.assertCurrent, deliver: async () => {
                        for (const step of steps) {
                            selection.assertCurrent();
                            const deliveryId = quickOperationChildId(body.deliveryId, step.effect), result = await step.run(deliveryId);
                            const value = result.body as Row, success = step.effect === "reply" ? result.status === 200 && value.status === "sent" && typeof value.sentMessageId === "string" && /^-?\d{1,20}$/.test(value.sentMessageId) && !/^-?0+$/.test(value.sentMessageId) : result.status === 200 && (value.delivery as Row)?.state === "completed";
                            effects.push({ effect: step.effect, deliveryId, state: success ? "completed" : "uncertain" });
                            if (!success)
                                throw new NapcatApiError(503, "QQ_QUICK_EFFECT_UNCERTAIN");
                        }
                        return { effects };
                    } });
                if (outcome.state === "conflict")
                    throw new NapcatApiError(409, "QQ_QUICK_DELIVERY_CONFLICT");
                return { status: outcome.state === "completed" ? 200 : 202, body: { code: 0, delivery: { deliveryId: outcome.deliveryId, state: outcome.state, duplicate: outcome.duplicate, retryable: false }, ...(outcome.state === "completed" ? { data: outcome.result } : { effects }) } };
            }
            catch (error) {
                return napcatApiFailure(error);
            }
        } };
}
