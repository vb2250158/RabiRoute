import { getTimeoutMs } from "../shared/timeoutSettings.js";
import { renderRabiDelivery, type RabiDeliveryEnvelope } from '../shared/rabiMessage.js';
import type { AgentInstanceBinding } from '../shared/agentInstance.js';
import type { AgentAdapter } from './contracts.js';

export type DeviceAgentAdapterOptions = {
  request?(binding: AgentInstanceBinding, method: string, path: string, body?: unknown): Promise<any>;
  waitMs?: number;
};
/** One delivery identity enters one device-owned turn; route binding selects automatic input only. */
export function createDeviceAgentAdapter(binding?: AgentInstanceBinding, options: DeviceAgentAdapterOptions = {}): AgentAdapter {
  const request = options.request || (async (selected: AgentInstanceBinding, method: string, path: string, body?: unknown) => {
    const base = process.env.GATEWAY_MANAGER_URL?.replace(/\/+$/,''), token = process.env.LAN_AGENT_ACCESS_TOKEN;
    if(!base || !token) throw new Error('DEVICE_AGENT_MANAGER_CONNECTION_REQUIRED');
    const response=await fetch(base+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json','x-rabi-device-agent-instance':selected.instanceId,'x-rabi-device-agent-route':process.env.GATEWAY_ID || ''},body:body===undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(getTimeoutMs("backend.agentAdapters.deviceAgentAdapter.createDeviceAgentAdapter.AbortSignal.timeout.request", 15000))});
    const result=await response.json() as any;
    if(!response.ok || result.code!==0) throw new Error(result.code || 'DEVICE_AGENT_DELIVERY_UNCONFIRMED');
    return result.data;
  });
  return {type:'deviceAgent',async deliver(envelope: RabiDeliveryEnvelope) {
    if(!binding) throw new Error('DEVICE_AGENT_BINDING_REQUIRED');
    if(!envelope.deliveryId || !renderRabiDelivery(envelope).trim()) throw new Error('DEVICE_AGENT_ORIGINAL_DELIVERY_REQUIRED');
    const base='/api/device-agents/'+encodeURIComponent(binding.agentId)+'/deliveries';
    let {receipt}=await request(binding,'POST',base,{deliveryId:envelope.deliveryId,envelope});
    const until=Date.now()+(options.waitMs ?? 25000);
    while(!receipt?.ownerAccepted) {
      if(receipt?.status==='result-unknown') throw new Error('DEVICE_AGENT_RESULT_UNKNOWN');
      if(receipt?.wake?.status==='failed') throw new Error('DEVICE_AGENT_WAKE_FAILED:'+String(receipt.wake.errorCode || 'UNKNOWN'));
      if(Date.now()>=until) throw new Error('DEVICE_AGENT_OWNER_NOT_LOADED');
      ({receipt}=await request(binding,'GET',base+'/'+encodeURIComponent(envelope.deliveryId)+'?waitMs='+Math.min(12000,Math.max(0,until-Date.now()))));
    }
    if(receipt.status==='failed') throw new Error('DEVICE_AGENT_EXECUTION_FAILED:'+String(receipt.response?.errorCode || 'UNKNOWN'));
    // A persisted queue or submitted gesture is never an owner acceptance receipt.
  }};
}
