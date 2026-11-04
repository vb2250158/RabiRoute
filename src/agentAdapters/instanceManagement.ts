import { callerCreationMetadataStatus } from "../callerCreationMetadata.js";
import { scanAgentAdapters } from "./managerApi.js";
import { handleAgentThreadRequest, type AgentThreadRequest } from "../agentThreads.js";
export { EndpointTransportReceipts } from "../agentRequests/endpointTransportReceipts.js";
export { sameAgentEndpoint } from "../agentRequests/endpoint.js";
export { subscribeCodexDesktopDelivery, CODEX_DESKTOP_LATE_RECEIPT_WINDOW_MS } from "../codexDesktopBridge.js";
import { executePreparedEndpointDelivery, type EndpointExecutionContext } from "../agentRequests/endpointExecution.js";
import type { PreparedEndpointDelivery } from "../agentRequests/endpointDelivery.js";
import { executeEndpointOnOwner, recoverEndpointOwnerReceipt } from "../agentRequests/ownerExecution.js";
import type { AgentManagerProvider } from "../manager/agentManagerProviders.js";
import { withAgentManagerInvocation, type AgentManagerOperationInvoker } from "./managerInvocation.js";
import { EndpointDeliveryNotSentError, validateEndpointDeliveryNoFrameProof } from "../agentRequests/deliveryFailure.js";

export type InstanceManagementContext = { rootDir: string; defaultWorkspace: string; allowedWorkspaces: string[]; dsh?: { baseUrl: string }; endpointExecution?: Omit<EndpointExecutionContext, "send">;
  getProviders?: () => readonly AgentManagerProvider[];
  invokeAgentOperation?: AgentManagerOperationInvoker;
  observeRecovery?: <T>(operation: () => Promise<T>) => Promise<T>;
  ownerTransport?: Parameters<typeof executeEndpointOnOwner>[3] };

/** Both transports execute the same provider operations on the owning computer. */
export async function manageInstanceAgent(operation: string, params: Record<string, unknown>, context: InstanceManagementContext): Promise<unknown> {
  return withAgentManagerInvocation(context, () => executeInstanceAgentOperation(operation, params, context));
}

async function executeInstanceAgentOperation(operation: string, params: Record<string, unknown>, context: InstanceManagementContext): Promise<unknown> {
  const dshBaseUrl = context.dsh?.baseUrl;
  if (operation === "scan") {
    const providers = context.getProviders?.() ?? [];
    const selected = typeof params.provider === "string" ? providers.filter(provider => provider.type === params.provider) : providers;
    if (typeof params.provider === "string" && !selected.length) throw new Error(`Agent plugin is unavailable: ${params.provider}.`);
    return scanAgentAdapters({ rootDir: context.rootDir, cwdOptions: context.allowedWorkspaces, providers: selected }, { dshBaseUrl });
  }
  if (operation === "prepared_delivery" || operation === "reconcile_prepared_delivery") {
    if (!context.endpointExecution) throw new Error("Prepared endpoint execution requires authenticated authority and transport receipts.");
    const delivery = params.delivery as PreparedEndpointDelivery;
    try {
      return await executePreparedEndpointDelivery(delivery, { ...context.endpointExecution,
        recoverReceipt: (prepared, assertAuthorized) => context.observeRecovery
          ? context.observeRecovery(() => recoverEndpointOwnerReceipt(prepared, assertAuthorized))
          : recoverEndpointOwnerReceipt(prepared, assertAuthorized),
        send: (prepared, assertAuthorized) => executeEndpointOnOwner(prepared, { allowedWorkspaces: context.allowedWorkspaces, dshBaseUrl }, assertAuthorized, context.ownerTransport)
      }, operation === "reconcile_prepared_delivery");
    } catch (error) {
      if (!(error instanceof EndpointDeliveryNotSentError) || !error.proof) throw error;
      validateEndpointDeliveryNoFrameProof(delivery, error.proof);
      await context.endpointExecution.assertAuthorized();
      return { status: "not_sent", proof: error.proof };
    }
  }
  if (operation === "threads") {
    if (params.action === "creation_status" || params.action === "create_metadata") {
      const intent = params.creationIntent as { callerKey?: unknown; intentHash?: unknown } | undefined;
      if (params.agentAdapter !== "codex" || typeof intent?.callerKey !== "string" || !/^agent-[a-f0-9]{64}$/.test(intent.callerKey)) throw new Error("An original caller metadata key is required.");
      if (params.action === "creation_status") return { statusCode: 200, data: { action: "creation_status", creation: callerCreationMetadataStatus(context.rootDir, intent.callerKey) } };
      if (params.prompt !== undefined || params.messageSource !== undefined || typeof intent.intentHash !== "string" || !/^[a-f0-9]{64}$/.test(intent.intentHash)) throw new Error("Metadata creation requires its frozen intent hash and no prompt or message source.");
      const result = await handleAgentThreadRequest({ action: "create", agentAdapter: "codex", title: params.title as string, cwd: params.cwd as string, sandbox: params.sandbox as AgentThreadRequest["sandbox"], model: params.model as string | undefined, reasoningEffort: params.reasoningEffort as AgentThreadRequest["reasoningEffort"] }, {
        invokeAgentOperation: context.invokeAgentOperation, getProviders: context.getProviders,
        allowedWorkspaces: context.allowedWorkspaces, defaultWorkspace: context.defaultWorkspace, creationRootDir: context.rootDir, creationIntent: { key: intent.callerKey, hash: intent.intentHash }
      });
      return result.statusCode < 200 || result.statusCode >= 300 ? result : { statusCode: result.statusCode, data: { action: "create_metadata", creation: callerCreationMetadataStatus(context.rootDir, intent.callerKey) } };
    }
    if (params.action === "send" || params.action === "reconcile_delivery") throw new Error("Remote delivery must be prepared by the Manager, not executed through a raw threads operation.");
    return handleAgentThreadRequest({ ...params, dshBaseUrl } as AgentThreadRequest, {
      invokeAgentOperation: context.invokeAgentOperation, getProviders: context.getProviders,
      allowedWorkspaces: context.allowedWorkspaces,
      defaultWorkspace: context.defaultWorkspace,
      dshBaseUrl
    });
  }
  if (operation === "hooks") {
    if (!context.invokeAgentOperation) throw new Error("Agent plugin operations are unavailable.");
    return context.invokeAgentOperation(String(params.provider || ""), "hooks.update", {});
  }
  throw new Error("Unsupported instance Agent operation.");
}
