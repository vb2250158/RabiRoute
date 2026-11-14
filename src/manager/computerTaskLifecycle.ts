import { planActivationStatus } from "../planState.js";
import type { LanAgentRegistry } from "./lanAgentRegistry.js";
export function computerAgentSourceId(nodeId: string, provider?: string, sessionId?: string): string {
  return JSON.stringify([nodeId, provider ?? null, sessionId ?? null]);
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
