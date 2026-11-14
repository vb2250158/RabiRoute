import { readDshSession, sendDshSessionMessage } from "../dshSessionBridge.js";
import type { EndpointDeliveryReceipt } from "@rabiroute/host-api/agentRequests/endpointDelivery";
import type { NativeOwnerDelivery } from "@rabiroute/host-api/agentRequests/nativeOwnerDelivery";
import type { AgentThreadRequestOptions } from "@rabiroute/host-api/agentThreads";
import { assertEndpointOwnerDirectory } from "@rabiroute/host-api/agentRequests/ownerExecution";
import { sameCodexWorkspace } from "@rabiroute/host-api/codexTaskIdentity";
export async function executeEndpointOnOwner(delivery: NativeOwnerDelivery, options: Pick<AgentThreadRequestOptions, "dshBaseUrl">,
  assertAuthorized: () => void | Promise<void>) {
  const endpoint = delivery.target;
  const { cwd, model, reasoningEffort, sandbox, dshDeliveryMode } = delivery.executionOptions;
  await assertAuthorized();
  assertEndpointOwnerDirectory(cwd);

    if (model !== undefined || reasoningEffort !== undefined || sandbox !== undefined) throw new Error("DSH owner protocol cannot apply model, reasoningEffort or sandbox.");
    const thread = await readDshSession(endpoint.sessionId, options.dshBaseUrl, assertAuthorized);
    await assertAuthorized();
    if (!thread || !thread.cwd || !sameCodexWorkspace(thread.cwd, cwd)) throw new Error("Exact DSH owner is unavailable.");
    return sendDshSessionMessage({ sessionId: endpoint.sessionId, prompt: delivery.prompt, cwd, baseUrl: options.dshBaseUrl,
      requestId: delivery.deliveryId, mode: dshDeliveryMode, assertAuthorized });

}

/** DSBot native operations are independent of primary Agent/session bindings and directory defaults. */
export async function executeDsBotRequestOnOwner(request: import("@rabiroute/host-api/agentThreads").AgentThreadRequest,
  options: { baseUrl?: string; assertNewAgentTask?: () => void; assertAuthorized?: () => void | Promise<void>; signal?: AbortSignal; request?: typeof import("../dshSessionBridge.js").requestDshBotAutomation } = {}) {
  const { requestDshBotAutomation } = await import("../dshSessionBridge.js");
  const invoke = options.request ?? requestDshBotAutomation;
  await options.assertAuthorized?.();
  if (request.agentAdapter !== "dsh" || request.threadId || request.createIfMissing || request.imagePaths?.length) throw new Error("Select an exact DSBot destination without ordinary Session options.");
  const catalog = request.action === "ds_bot_catalog";
  if (!catalog && (!request.dsBot?.botScopeId?.trim() || !request.dsBot.botId?.trim() || !request.deliveryId?.trim() || typeof request.prompt !== "string" || !request.prompt.trim())) throw new Error("DSBot delivery requires its original scope, Bot, delivery ID and message.");
  const scheduledAt = request.dsBot?.scheduledAt;
  if (!catalog && scheduledAt !== undefined && (typeof scheduledAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(scheduledAt)
    || !Number.isFinite(Date.parse(scheduledAt)) || new Date(scheduledAt).toISOString() !== scheduledAt.replace(/Z$/, scheduledAt.includes(".") ? "Z" : ".000Z"))) throw new Error("DSBot scheduledAt requires the original valid UTC occurrence time.");
  const endpoint = catalog ? "rabi-automation-catalog" : request.action === "ds_bot_deliver" ? "rabi-automation-deliver" : request.action === "ds_bot_reconcile" ? "rabi-automation-reconcile" : undefined;
  if (!endpoint) throw new Error("Unsupported DSBot operation.");
  const payload = { schemaVersion: 1 as const, ...(catalog ? {} : { ...request.dsBot, deliveryId: request.deliveryId, message: request.prompt }) };
  if (endpoint === "rabi-automation-deliver") {
    const original = await invoke("rabi-automation-reconcile", payload, options);
    await options.assertAuthorized?.();
    if (!("state" in original)) throw new Error("DSBot reconciliation returned no original delivery state.");
    if (original.state !== "not_found") return { statusCode: 200, data: { action: request.action, ok: true, dsBot: original } };
    // Local Manager owns this feature policy; remote instance transports classify new work at their existing owner gate.
    options.assertNewAgentTask?.();
  }
  const dsBot = await invoke(endpoint, payload, options);
  await options.assertAuthorized?.();
  return { statusCode: 200, data: { action: request.action, ok: true, dsBot } };
}
