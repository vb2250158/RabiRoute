import path from "node:path";
import { createHash } from "node:crypto";
import type { PeerAgentEndpointOptions } from "@rabiroute/host-api/manager/peerAgentEndpointBridge";
import type { ApiOperationDefinition, ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { AgentAdapterType } from "@rabiroute/host-api/agentAdapters/types";
import type { EndpointDeliveryReceipt } from "@rabiroute/host-api/agentRequests/endpointDelivery";
import type { NativeOwnerDelivery } from "@rabiroute/host-api/agentRequests/nativeOwnerDelivery";
import { executeNativeOwnerDelivery, reconcileNativeOwnerDelivery } from "@rabiroute/host-api/agentRequests/endpointExecution";
import { executeEndpointOnOwner, recoverEndpointOwnerReceipt } from "@rabiroute/host-api/agentRequests/ownerExecution";
import { EndpointTransportReceipts } from "@rabiroute/host-api/agentRequests/endpointTransportReceipts";
import { agentDeliveryPromptHash } from "@rabiroute/host-api/agentRequests/store";
import { endpointExecutionOptionsHash, normalizeEndpointExecutionOptions, type EndpointExecutionOptions } from "@rabiroute/host-api/agentRequests/executionOptions";
import { EndpointDeliveryNotSentError } from "@rabiroute/host-api/agentRequests/deliveryFailure";

type Options = Pick<PeerAgentEndpointOptions, "managerInstanceId" | "localDeviceId" | "scope" | "principal" | "readLocal" | "localOptions" | "receiptDirectory" | "executeOwner" | "recoverOwner">;
type RouteDeliveryInput = { instanceId: string; provider: AgentAdapterType; threadId: string; prompt?: string; deliveryId: string; cwd?: string; model?: string; reasoningEffort?: string; sandbox?: string; dshDeliveryMode?: string };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Route envelopes are native execution, not Agent-to-Agent messages or a second business intent. */
export function createPeerRouteDeliveryOperations(options: Options): readonly ApiOperationDefinition[] {
  return [false, true].map(reconcile => {
    const prepare = (input: Omit<ApiOperationInput, "body">) => {
      const principal = options.principal(input.request), scope = options.scope(), local = options.localDeviceId();
      if (!principal?.deviceOwner || !scope || principal.scope !== scope) throw new Error("An authenticated peer Manager connection is required.");
      const guard = () => {
        input.signal?.throwIfAborted();
        const current = options.principal(input.request);
        if (options.scope() !== scope || options.localDeviceId() !== local || !current?.deviceOwner
          || current.scope !== scope || current.sourceDeviceId !== principal.sourceDeviceId) throw new Error("Original Route peer connection changed.");
      };
      guard();
      return async (parsed: ApiOperationInput) => {
        const body = parsed.body as RouteDeliveryInput;
        guard();
        if (body.instanceId !== options.managerInstanceId) throw new Error("Route delivery requires the target Manager's exact local instance.");
        const target = { kind: "instance" as const, managerInstanceId: options.managerInstanceId, ownerDeviceId: local,
          instanceId: options.managerInstanceId, nodeId: options.managerInstanceId, agentId: `local:${body.provider}`,
          provider: body.provider, sessionId: body.threadId,
          authorizationIncarnation: digest([scope, principal.sourceDeviceId, options.managerInstanceId, body.provider, body.threadId]) };
        const receipts = new EndpointTransportReceipts(path.join(options.receiptDirectory, digest(principal.sourceDeviceId)));
        const receiptIdentity = { deliveryId: body.deliveryId, generation: digest([principal.sourceDeviceId, options.managerInstanceId, body.deliveryId]), target };
        if (reconcile && body.prompt === undefined) {
          const original = receipts.readReceiptByIdentity(receiptIdentity); guard();
          let receipt = original.receipt;
          if (!receipt && original.delivery && !original.notSent) {
            try {
              receipt = await reconcileNativeOwnerDelivery(original.delivery, {
                assertAuthorized: guard,
                readReceipt: value => receipts.readReceipt(value),
                writeReceipt: (value, proof) => receipts.writeReceipt(value, proof),
                beginAttempt: value => receipts.beginAttempt(value),
                readNotSent: value => receipts.readNotSentProof(value),
                recoverReceipt: options.recoverOwner ?? recoverEndpointOwnerReceipt
              });
            } catch (error) {
              guard();
              // A concurrent original no-frame result is read back below; all
              // other failures retain uncertainty and never become a new send.
              if (!(error instanceof EndpointDeliveryNotSentError && error.proof))
                return { status: 202, body: { code: 0, uncertain: true, result: { taskId: body.deliveryId, status: "awaiting_confirmation" } } };
            }
          }
          guard();
          const current = receipts.readReceiptByIdentity(receiptIdentity);
          receipt ??= current.receipt;
          return { status: 200, body: { code: 0, threadId: body.threadId, result: { taskId: body.deliveryId, status: receipt ? "delivered" : "awaiting_confirmation" },
            delivery: { deliveryId: body.deliveryId, state: receipt ? "accepted" : current.notSent ? "missing" : current.found ? "uncertain" : "missing" }, ...(receipt ? { receipt } : {}) } };
        }
        if (typeof body.prompt !== "string") throw new Error("Native Route delivery requires its original rendered prompt.");
        const sourceManager = `/api/rabilink/peer/http/${encodeURIComponent(principal.sourceDeviceId)}/manager`;
        const prompt = body.prompt + "\n\n[来源主机与接口]\n"
          + `本条消息所附的 Route、角色、计划及渠道回传接口归来源主机 ${principal.sourceDeviceId}。\n`
          + `使用当前电脑 Manager 的 ${sourceManager} 前缀访问来源接口；例如 ${sourceManager}/meta 核对来源身份，${sourceManager}/api/roles/<roleId>/... 访问来源角色接口。\n`
          + "Manager 地址使用当前主机的动态发现结果。文件、CLI 与任务工作目录仍归当前执行电脑；不要把来源主机的相对接口路径误用到当前电脑。";
        const identity = { deliveryId: body.deliveryId, generation: digest([principal.sourceDeviceId, options.managerInstanceId, body.deliveryId]),
          target, promptHash: agentDeliveryPromptHash(prompt) };
        let originalOptions: EndpointExecutionOptions | undefined;
        try { originalOptions = receipts.readExecutionOptions(identity); }
        catch (error) {
          if ((error as { code?: string }).code === "DELIVERY_INPUT_CONFLICT") return { status: 409, body: { code: -1, commitState: "not_started", deliveryId: body.deliveryId, message: (error as Error).message } };
          throw error;
        }
        guard();
        if (reconcile && !originalOptions && !body.cwd) return { status: 202, body: { code: 0, result: { taskId: body.deliveryId, status: "awaiting_confirmation" }, uncertain: true } };
        const summary = !originalOptions && !body.cwd ? await options.readLocal(body.provider, body.threadId) : undefined; guard();
        const executionOptions = normalizeEndpointExecutionOptions({ ...originalOptions, cwd: body.cwd ?? originalOptions?.cwd ?? summary?.cwd,
          ...(body.model !== undefined ? { model: body.model } : {}), ...(body.reasoningEffort !== undefined ? { reasoningEffort: body.reasoningEffort } : {}),
          ...(body.sandbox !== undefined ? { sandbox: body.sandbox } : {}), ...(body.dshDeliveryMode !== undefined ? { dshDeliveryMode: body.dshDeliveryMode } : {}) });
        const delivery: NativeOwnerDelivery = { deliveryId: body.deliveryId,
          generation: digest([principal.sourceDeviceId, options.managerInstanceId, body.deliveryId]), target,
          prompt, promptHash: agentDeliveryPromptHash(prompt), executionOptions,
          executionOptionsHash: endpointExecutionOptionsHash(executionOptions), dispatchAttemptId: digest([principal.sourceDeviceId, body.deliveryId]) };
        const context = { endpoint: target, assertAuthorized: guard,
          readReceipt: (value: NativeOwnerDelivery) => receipts.readReceipt(value),
          writeReceipt: (value: NativeOwnerDelivery, receipt: EndpointDeliveryReceipt) => receipts.writeReceipt(value, receipt),
          beginAttempt: (value: NativeOwnerDelivery) => receipts.beginAttempt(value),
          readNotSent: (value: NativeOwnerDelivery) => receipts.readNotSentProof(value),
          writeNotSent: (value: NativeOwnerDelivery, error: EndpointDeliveryNotSentError) => receipts.writeNotSent(value, error),
          recoverReceipt: options.recoverOwner ?? recoverEndpointOwnerReceipt,
          send: (value: NativeOwnerDelivery, authorized: () => Promise<void>) => (options.executeOwner ?? executeEndpointOnOwner)(value,
            options.localOptions({ agentAdapter: body.provider, threadId: body.threadId }), authorized) };
        let receipt: EndpointDeliveryReceipt | undefined;
        try {
          delivery.dispatchAttemptId = receipts.nativeDispatchAttemptId(delivery, !reconcile);
          receipt = await executeNativeOwnerDelivery(delivery, context, reconcile);
          if (!receipt && !reconcile) receipt = await executeNativeOwnerDelivery(delivery, context, true);
        } catch (error) {
          guard();
          if ((error as { code?: string }).code === "DELIVERY_INPUT_CONFLICT" || error instanceof EndpointDeliveryNotSentError && error.proof)
            return { status: 409, body: { code: -1, commitState: "not_started", deliveryId: body.deliveryId, message: (error as Error).message } };
          return { status: 202, body: { code: 0, uncertain: true, result: { taskId: body.deliveryId, status: "awaiting_confirmation" } } };
        }
        guard();
        return { status: receipt ? 200 : 202, body: { code: 0, result: { taskId: body.deliveryId, status: receipt ? "delivered" : "awaiting_confirmation" },
          ...(receipt ? { receipt } : { uncertain: true }) } };
      };
    };
    return { contract: { operationId: `manager.agent.route-deliveries.${reconcile ? "reconcile" : "execute"}`, contractVersion: "1.0.0", method: "POST",
      pathTemplate: "/api/agent/route-deliveries" + (reconcile ? "/reconcile" : ""), exposure: "public", transport: "http",
      description: "Deliver an already-rendered Route envelope to an exact native task through the existing authenticated Peer connection; retain only execution receipts.",
      request: { path: { type: "object" }, query: { type: "object" }, headers: { type: "object" }, body: { kind: "json", maxBytes: 0,
        schema: { type: "object", required: ["instanceId", "provider", "threadId", "deliveryId", ...(reconcile ? [] : ["prompt"])], additionalProperties: false, properties: {
          instanceId: { type: "string", minLength: 1 }, provider: { type: "string", minLength: 1 }, threadId: { type: "string", minLength: 1 },
          prompt: { type: "string", minLength: 1 }, deliveryId: { type: "string", minLength: 1 }, cwd: { type: "string" }, model: { type: "string" }, reasoningEffort: { type: "string" }, sandbox: { type: "string" }, dshDeliveryMode: { type: "string" }
        } } } }, responses: { "200": { mediaType: "application/json", schema: { type: "object" } }, "202": { mediaType: "application/json", schema: { type: "object" } },
        "409": { mediaType: "application/json", schema: { type: "object", additionalProperties: false,
          required: ["code", "commitState", "deliveryId", "message"], properties: { code: { const: -1 }, commitState: { const: "not_started" },
            deliveryId: { type: "string" }, message: { type: "string" } } } } },
      effects: { mode: reconcile ? "native-receipt-reconciliation" : "native-route-execution", description: "The original Route owns its message intent. Shared native execution and EndpointTransportReceipts prevent duplicate execution without Agent source fabrication or registration." },
      recovery: { strategy: "same-route-delivery-id", description: "Reconcile the exact original ID, target and payload; an uncertain attempt is never dispatched again." },
      validators: [{ id: "original-peer-route-owner", description: "Existing authenticated Peer admission and exact native task ownership remain authoritative; no Route or Agent registration is required on the target." }]
    }, prepare, handler: input => prepare(input)(input) };
  });
}
