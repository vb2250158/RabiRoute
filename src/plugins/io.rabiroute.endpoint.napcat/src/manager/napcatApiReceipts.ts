import { compileApiContract, type ApiOperationDefinition } from "@rabiroute/host-api/manager/apiOperationContract";
import { readDurableDeliveryReceipt } from "@rabiroute/host-api/manager/durableDeliveryIdempotency";
import { napcatApiFailure, NapcatApiError, selectNapcatApiInstance } from "./napcatApiTransport.js";
import type { NapcatApiOperationsContext } from "./napcatApiOperations.js";

/** Read the original durable record without calling the platform or changing its state. */
export function createNapcatApiReceiptOperation(context: NapcatApiOperationsContext): ApiOperationDefinition {
  const selector = { type: "string", minLength: 1, maxLength: 256 };
  const contract = {
    operationId: "agent.qq.onebot.receipt.read", contractVersion: "1.0.0", method: "GET" as const,
    pathTemplate: "/api/agent/qq/onebot-receipts/:deliveryId", exposure: "public" as const, transport: "http" as const,
    description: "Read a NapCat action's original durable receipt for its exact configured Route, instance and QQ account. No platform request or retry is performed.",
    request: { path: { type: "object", required: ["deliveryId"], additionalProperties: false, properties: { deliveryId: { type: "string", minLength: 1, maxLength: 200 } } },
      query: { type: "object", required: ["routeId", "instanceId"], additionalProperties: false, properties: { routeId: selector, instanceId: selector } },
      headers: { type: "object" }, body: { kind: "none" as const } },
    responses: {
      "200": { mediaType: "application/json", schema: { type: "object", required: ["code", "receipt"], additionalProperties: false,
        properties: { code: { const: 0 }, receipt: { type: "object", additionalProperties: false,
          required: ["deliveryId", "state", "createdAt", "updatedAt", "action", "retryable"],
          properties: { deliveryId: selector, state: { enum: ["reserved", "sending", "completed", "uncertain"] }, createdAt: selector,
            updatedAt: selector, action: selector, retryable: { const: false } } } } } },
      default: { mediaType: "application/json", schema: { type: "object", required: ["code", "errorCode"], additionalProperties: false,
        properties: { code: { const: -1 }, errorCode: { type: "string" } } } }
    },
    effects: { mode: "read" as const, description: "Original durable record only; no provider call or receipt mutation." },
    recovery: { strategy: "retain-original-id", description: "An uncertain receipt remains uncertain. This read never replays a platform mutation." }, validators: []
  };
  const compiled = compileApiContract({ contract });
  return { contract, discovery: { title: "Read QQ action receipt", summary: contract.description,
    keywords: ["NapCat", "OneBot", "receipt", "deliveryId"], category: { id: "qq-onebot", title: "QQ / NapCat" } },
    handler: async input => {
      try {
        if (!compiled.pathValidator?.(input.path) || !compiled.queryValidator?.(input.query)) throw new NapcatApiError(400, "QQ_API_PARAMETERS_INVALID");
        const selection = selectNapcatApiInstance(context, input.request, String(input.query.routeId), String(input.query.instanceId), input.signal);
        const receipt = readDurableDeliveryReceipt(context.rootDir, "napcat-onebot-actions", String(input.path.deliveryId));
        selection.assertCurrent();
        const audit = receipt?.audit as Record<string, unknown> | undefined;
        if (!receipt || audit?.routeId !== selection.routeId || audit?.instanceId !== selection.instanceId
          || audit?.botUserId !== selection.botUserId || typeof audit?.action !== "string") throw new NapcatApiError(404, "QQ_API_RECEIPT_NOT_FOUND");
        return { status: 200, headers: { "cache-control": "private, no-store" }, body: { code: 0,
          receipt: { deliveryId: receipt.deliveryId, state: receipt.state, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt,
            action: audit.action, retryable: false } } };
      } catch (error) { return napcatApiFailure(error); }
    } };
}
