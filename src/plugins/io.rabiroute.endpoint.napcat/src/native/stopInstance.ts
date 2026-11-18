import { compileApiContract, type ApiOperationContract, type ApiOperationDefinition } from "@rabiroute/host-api/manager/apiOperationContract";
import { executeDurableDelivery } from "@rabiroute/host-api/manager/durableDeliveryIdempotency";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import { selectNapcatApiInstance, verifyNapcatApiIdentity, NapcatApiError, napcatApiFailure, type NapcatApiTransportContext } from "../manager/napcatApiTransport.js";
export type NapcatStopContext = NapcatApiTransportContext & {
    rootDir: string;
    readOnly(): boolean;
    stopOwnedNapcat(request: {
        gatewayId: string;
        instanceId: string;
    }, authorize: () => void): Promise<{
        ok?: unknown;
    }>;
};
/** The original lifecycle owner drains its own binding. This wrapper must not take that same binding lock. */
export function createNapcatStopOperation(context: NapcatStopContext): ApiOperationDefinition {
    const empty = { type: "object", additionalProperties: false };
    const contract: ApiOperationContract = {
        operationId: "agent.qq.onebot.bot_exit", aliases: ["agent.qq.onebot.bot_exit_async", "agent.qq.onebot.bot_exit_rate_limited"],
        contractVersion: "1.0.0", method: "POST", pathTemplate: "/api/agent/qq/onebot/bot_exit", exposure: "public", transport: "http",
        description: "Account-preserving compatibility view through the original stopNapcatInstance lifecycle owner. It drains and stops only the selected managed native instance, retaining Route/account configuration. It does not stop Rabi Host or remove the instance. This does not invoke the upstream process.exit(0) handler or claim raw native contract equivalence.",
        request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "json", maxBytes: qqReadSettings.jsonBytes, schema: {
                    type: "object", additionalProperties: false, required: ["routeId", "instanceId", "deliveryId", "params"], properties: {
                        routeId: { type: "string", minLength: 1, maxLength: 256 }, instanceId: { type: "string", minLength: 1, maxLength: 256 },
                        deliveryId: { type: "string", minLength: 1, maxLength: 200 }, params: empty
                    }
                } } },
        responses: { "200": { mediaType: "application/json", schema: { type: "object", required: ["code", "stopped", "nativeContractEquivalent", "delivery"],
                    properties: { code: { const: 0 }, stopped: { const: true }, nativeContractEquivalent: { const: false }, delivery: { type: "object" } } } },
            "202": { mediaType: "application/json", schema: { type: "object", required: ["code", "delivery"], properties: { code: { const: 0 }, delivery: { type: "object" } } } },
            default: { mediaType: "application/json", schema: { type: "object", required: ["code", "errorCode"], properties: { code: { const: -1 }, errorCode: { type: "string" } } } } },
        effects: { mode: "native-napcat-control", description: "Original process ownership, binding admission/drain, manual-stop state and account configuration remain authoritative." },
        recovery: { strategy: "original-durable-receipt-no-replay", description: "A lost stop response remains unknown under its original deliveryId. It never authorizes another exit. Completed receipts remain readable even after the original native endpoint is stopped." },
        validators: [{ id: "napcat.original-stop-owner", description: "Exact configured binding, actual QQ before first stop, original owner ok:true, and unchanged Route/configuration across awaits." }]
    };
    const validator = compileApiContract({ contract }).bodyValidator!;
    return { contract, async handler(input) {
            try {
                if (!validator(input.body))
                    throw new NapcatApiError(400, "QQ_API_PARAMETERS_INVALID");
                if (context.readOnly())
                    throw new NapcatApiError(403, "QQ_API_READ_ONLY");
                const body = input.body as {
                    routeId: string;
                    instanceId: string;
                    deliveryId: string;
                };
                const selection = selectNapcatApiInstance(context, input.request, body.routeId, body.instanceId, input.signal);
                const outcome = await executeDurableDelivery({ rootDir: context.rootDir, namespace: "napcat-onebot-actions", deliveryId: body.deliveryId,
                    payload: { action: "bot_exit", routeId: body.routeId, instanceId: body.instanceId, botUserId: selection.botUserId, params: {} },
                    audit: { action: "bot_exit", routeId: body.routeId, instanceId: body.instanceId, botUserId: selection.botUserId },
                    requestAuthority: selection.assertCurrent,
                    deliver: async () => {
                        const signal = input.signal ?? AbortSignal.timeout(getTimeoutMs("qq.nativeExit", 60000));
                        await verifyNapcatApiIdentity(context, selection, signal);
                        const stopped = await context.stopOwnedNapcat({ gatewayId: body.routeId, instanceId: body.instanceId }, selection.assertCurrent);
                        selection.assertCurrent();
                        if (stopped.ok !== true)
                            throw new NapcatApiError(503, "QQ_NATIVE_STOP_UNCONFIRMED");
                        return { stopped: true, nativeContractEquivalent: false };
                    }
                });
                selection.assertCurrent();
                if (outcome.state === "conflict")
                    throw new NapcatApiError(409, "QQ_API_DELIVERY_CONFLICT");
                if (outcome.state !== "completed")
                    return { status: 202, body: { code: 0,
                            delivery: { deliveryId: outcome.deliveryId, state: outcome.state, retryable: false } } };
                return { status: 200, body: { code: 0, ...outcome.result,
                        delivery: { deliveryId: outcome.deliveryId, state: outcome.state, duplicate: outcome.duplicate } } };
            }
            catch (error) {
                return napcatApiFailure(error);
            }
        } };
}
