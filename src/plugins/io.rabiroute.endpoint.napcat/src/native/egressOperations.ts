import type { MessageEndpointAgentSendProducer, MessageEndpointAgentSendRequest } from "@rabiroute/plugin-sdk";
import { compileApiContract, type ApiOperationContract, type ApiOperationDefinition } from "@rabiroute/host-api/manager/apiOperationContract";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { selectNapcatApiInstance, NapcatApiError, napcatApiFailure, type NapcatApiTransportContext } from "../manager/napcatApiTransport.js";
import { createNapcatNativeEgressProducers, type NapcatNativeEgressContext } from "./egressProducers.js";
export type NapcatEgressOperationContext = NapcatApiTransportContext & Pick<NapcatNativeEgressContext, "resolveNativeDirectory"> & {
    submitAgentSendVariant: MessageEndpointAgentSendProducer;
};
/** Exact HTTP compatibility views enter the same admitted agent.send owner; no second receipt or raw action transport exists. */
export function createNapcatNativeEgressOperations(context: NapcatEgressOperationContext): readonly ApiOperationDefinition[] {
    return createNapcatNativeEgressProducers(context).map(producer => {
        const bodySchema = {
            type: "object", additionalProperties: false, required: ["deliveryId", "sender", "routeId", "params", "data"],
            properties: {
                deliveryId: { type: "string", minLength: 1, maxLength: 256 }, routeId: { type: "string", minLength: 1, maxLength: 256 },
                sender: { type: "object", additionalProperties: false, required: ["agentType", "sessionId"], properties: {
                        agentType: { type: "string", minLength: 1, maxLength: 128 }, sessionId: { type: "string", minLength: 1, maxLength: 256 }
                    } },
                params: producer.variant.paramsSchema, data: producer.variant.dataSchema,
                styleValidation: { enum: [0, 1, null] }, messageLengthConfirmation: { type: ["string", "null"] },
                tracking: { type: "object", additionalProperties: false, properties: { requirementId: { type: "string" } } },
                conversationContext: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, properties: {
                                lastReadMessageIndex: { type: "string" }, confirmationToken: { type: "string" }
                            } }] }
            }
        };
        const contract: ApiOperationContract = {
            operationId: `agent.qq.onebot.${producer.action}`, aliases: [`agent.qq.onebot.${producer.action}_async`, `agent.qq.onebot.${producer.action}_rate_limited`],
            contractVersion: "1.0.0", method: "POST", pathTemplate: `/api/agent/qq/onebot/${producer.action}`, exposure: "public", transport: "http",
            description: `${producer.variant.description} This source/managed-media compatibility shape is not the unrestricted upstream native contract. Aliases use the original synchronous outbox admission, not a new upstream async queue.`,
            request: { path: { type: "object", additionalProperties: false }, query: { type: "object", additionalProperties: false }, headers: { type: "object" },
                body: { kind: "json", maxBytes: qqReadSettings.jsonBytes, schema: bodySchema } },
            responses: { default: { mediaType: "application/json", schema: { type: "object" } } },
            effects: { mode: "write", description: "Original agent.send applies sender authority, Route output rules, language/length policy, managed attachments and the existing durable outbox." },
            recovery: { strategy: "original-agent-send-receipt", description: "Read the original stable deliveryId. Accepted or uncertain intents are never automatically repeated. Ack-only outcomes do not imply visible platform delivery." },
            validators: [{ id: "napcat.original-egress-owner", description: "Pass the same admitted request and current selection guard into host.message-endpoints@3.manager.submitAgentSendVariant." }]
        };
        const validator = compileApiContract({ contract }).bodyValidator!;
        return {
            contract,
            async handler(input) {
                try {
                    if (!validator(input.body)) {
                        throw new NapcatApiError(400, "QQ_NATIVE_EGRESS_INPUT_INVALID");
                    }
                    const body = input.body as Omit<MessageEndpointAgentSendRequest, "channel" | "payload"> & {
                        data: Record<string, unknown>;
                    };
                    const selection = selectNapcatApiInstance(context, input.request, body.routeId, String(body.params.instanceId), input.signal);
                    const { data, ...requestBody } = body;
                    const result = await context.submitAgentSendVariant(input.request, {
                        ...requestBody, channel: "napcat", payload: { type: producer.variant.type, data }
                    }, selection.assertCurrent);
                    return { status: result.statusCode, body: result.body };
                }
                catch (error) {
                    return napcatApiFailure(error);
                }
            }
        };
    });
}
