import { planActivationStatus } from "../planState.js";
import type { IncomingMessage } from "node:http";
import { isAgentAdapterType } from "../shared/agentAdapterCapabilities.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { getTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import type { LanAgentRegistry } from "./lanAgentRegistry.js";
export function computerAgentSourceId(nodeId: string, provider?: string, sessionId?: string): string {
  return JSON.stringify([nodeId, provider ?? null, sessionId ?? null]);
}

export function computerAgentSession(request: IncomingMessage, localInstanceId: string) {
  const admitted = getTrustedLanAgentSource(request);
  if (!admitted && !hasAuthenticatedConnectionRequest(request)) return undefined;
  const provider = admitted ? admitted.provider : request.headers["x-rabiroute-agent-type"];
  const taskId = admitted ? admitted.sessionId : request.headers["x-rabiroute-session-id"];
  if (!isAgentAdapterType(provider) || typeof taskId !== "string" || !taskId.trim() || taskId.length > 256) return undefined;
  return { sourceId: computerAgentSourceId(admitted?.nodeId ?? localInstanceId, provider, taskId), sourceLabel: admitted?.sessionName || provider, taskId };
}
type ComputerPlan = Parameters<typeof planActivationStatus>[0] & {
  id?: string; taskBinding?: {agentType: string; sessionId: string; instanceBinding?: {instanceId: string; ownerDeviceId?: string}};
};
/** A plan ending is business evidence; a model turn ending is not. No task/address is invented. */
export async function endComputerTrackingForPlan(plan: ComputerPlan, registry: Pick<LanAgentRegistry,"listInstances"|"endComputerTask">,
  localDeviceId: string, diagnostic: (instanceId:string,error:unknown)=>void): Promise<void> {
  if (planActivationStatus(plan) === "进行中") return;
  const binding=plan.taskBinding, source=binding?.instanceBinding;
  if (!binding?.sessionId || !source?.instanceId || source.ownerDeviceId && source.ownerDeviceId !== localDeviceId) return;
  const sourceId=computerAgentSourceId(source.instanceId,binding.agentType,binding.sessionId);
  const targets=registry.listInstances().filter(row=>row.connected && row.computerCapabilities?.includes("annotation"));
  await Promise.all(targets.map(async row=>{try{await registry.endComputerTask(row.instanceId,binding.sessionId,sourceId);}catch(error){diagnostic(row.instanceId,error);}}));
}
