import { scanAgentAdapters, scanDshAgentAdapter } from "./managerApi.js";
import { handleAgentThreadRequest, type AgentThreadRequest } from "../agentThreads.js";
export { EndpointTransportReceipts } from "../agentRequests/endpointTransportReceipts.js";
export { sameAgentEndpoint } from "../agentRequests/endpoint.js";
import { executePreparedEndpointDelivery, type EndpointExecutionContext } from "../agentRequests/endpointExecution.js";
import type { PreparedEndpointDelivery } from "../agentRequests/endpointDelivery.js";
import { executeEndpointOnOwner, recoverEndpointOwnerReceipt } from "../agentRequests/ownerExecution.js";
import { updateAgentHooks } from "./hookInstallation.js";

export type InstanceManagementContext = { rootDir: string; defaultWorkspace: string; allowedWorkspaces: string[]; dsh?: { baseUrl: string }; endpointExecution?: Omit<EndpointExecutionContext, "send"> };

/** Both transports execute the same provider operations on the owning computer. */
export async function manageInstanceAgent(operation: string, params: Record<string, unknown>, context: InstanceManagementContext): Promise<unknown> {
  const dshBaseUrl = context.dsh?.baseUrl;
  if (operation === "scan") {
    const scanContext = { rootDir: context.rootDir, cwdOptions: context.allowedWorkspaces };
    return params.provider === "dsh"
      ? scanDshAgentAdapter(scanContext, { dshBaseUrl })
      : scanAgentAdapters(scanContext, { dshBaseUrl });
  }
  if (operation === "prepared_delivery" || operation === "reconcile_prepared_delivery") {
    if (!context.endpointExecution) throw new Error("Prepared endpoint execution requires authenticated authority and transport receipts.");
    const delivery = params.delivery as PreparedEndpointDelivery;
    return executePreparedEndpointDelivery(delivery, { ...context.endpointExecution,
      recoverReceipt: recoverEndpointOwnerReceipt,
      send: (prepared, assertAuthorized) => executeEndpointOnOwner(prepared, { allowedWorkspaces: context.allowedWorkspaces, dshBaseUrl }, assertAuthorized)
    }, operation === "reconcile_prepared_delivery");
  }
  if (operation === "threads") {
    if (params.action === "send" || params.action === "reconcile_delivery") throw new Error("Remote delivery must be prepared by the Manager, not executed through a raw threads operation.");
    return handleAgentThreadRequest({ ...params, dshBaseUrl } as AgentThreadRequest, {
      allowedWorkspaces: context.allowedWorkspaces,
      defaultWorkspace: context.defaultWorkspace,
      dshBaseUrl
    });
  }
  if (operation === "hooks") return updateAgentHooks(context.rootDir, String(params.provider || ""));
  throw new Error("Unsupported instance Agent operation.");
}
