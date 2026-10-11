import type { PreparedEndpointDelivery } from '../agentRequests/endpointDelivery.js';
import { sameAgentEndpoint } from '../agentRequests/endpoint.js';
import type { AgentRequestEndpoint } from '../agentRequests/endpoint.js';
import { agentDeliveryPromptHash } from '../agentRequests/store.js';
import { endpointExecutionOptionsHash } from '../agentRequests/executionOptions.js';

export type DeviceAgentPreparedInput = { ledgerOwnerDeviceId: string; delivery: PreparedEndpointDelivery };
export type DeviceAgentPreparedPrincipal = { scope: string; ledgerOwnerDeviceId: string };
export type DeviceAgentPreparedClaimEvidence = { ledgerOwnerDeviceId:string;deliveryId:string;generation:string;source:AgentRequestEndpoint;target:AgentRequestEndpoint;promptHash:string;executionOptionsHash:string };
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value && typeof value==='object')return '{'+Object.keys(value).sort().filter(key=>(value as Record<string,unknown>)[key]!==undefined).map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
  return JSON.stringify(value) ?? 'null';
}
/** The connection owner supplies authentication; this matcher only verifies the original ledger reservation. */
export function assertDeviceAgentPreparedAuthority(input:DeviceAgentPreparedInput, proof:any):void {
  const delivery=input?.delivery;
  if(!delivery || typeof input.ledgerOwnerDeviceId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(input.ledgerOwnerDeviceId)
    || !['dispatching','committed'].includes(delivery.state) || delivery.target?.kind!=='device' || delivery.target.provider!=='deviceAgent'
    || delivery.promptHash!==agentDeliveryPromptHash(delivery.prompt) || delivery.executionOptionsHash!==endpointExecutionOptionsHash(delivery.executionOptions)
    || !sameAgentEndpoint(delivery.source,delivery.preparation?.source.endpoint) || !sameAgentEndpoint(delivery.target,delivery.preparation?.target.endpoint)
    || proof?.authorized!==true || !['dispatching','committed'].includes(proof.state) || proof.deliveryId!==delivery.deliveryId || proof.generation!==delivery.generation
    || proof.ledgerManagerInstanceId!==delivery.target.managerInstanceId || proof.ledgerManagerInstanceId!==delivery.source.managerInstanceId
    || proof.promptHash!==delivery.promptHash || proof.executionOptionsHash!==delivery.executionOptionsHash
    || !sameAgentEndpoint(proof.source,delivery.source) || !sameAgentEndpoint(proof.endpoint,delivery.target)
    || canonical(proof.preparation)!==canonical(delivery.preparation)) throw Object.assign(new Error('DEVICE_AGENT_LEDGER_AUTHORITY_MISMATCH'),{code:'DEVICE_AGENT_LEDGER_AUTHORITY_MISMATCH',statusCode:403});
}
/** Claim-time evidence contains transport identities only; it does not persist another Manager's request record. */
export function assertDeviceAgentPreparedClaimAuthority(evidence:DeviceAgentPreparedClaimEvidence,proof:any):void {
  if(!proof || proof.deliveryId!==evidence.deliveryId || proof.generation!==evidence.generation
    || proof.ledgerManagerInstanceId!==evidence.source.managerInstanceId || proof.ledgerManagerInstanceId!==evidence.target.managerInstanceId
    || proof.promptHash!==evidence.promptHash || proof.executionOptionsHash!==evidence.executionOptionsHash
    || !sameAgentEndpoint(proof.source,evidence.source) || !sameAgentEndpoint(proof.endpoint,evidence.target)) throw Object.assign(new Error('DEVICE_AGENT_LEDGER_AUTHORITY_MISMATCH'),{code:'DEVICE_AGENT_LEDGER_AUTHORITY_MISMATCH',statusCode:403});
  if(proof.authorized===false && proof.state==='cancelled') throw Object.assign(new Error('DEVICE_AGENT_LEDGER_CANCELLED'),{code:'DEVICE_AGENT_LEDGER_CANCELLED',statusCode:403});
  if(proof.authorized!==true || !['dispatching','committed'].includes(proof.state)) throw Object.assign(new Error('DEVICE_AGENT_LEDGER_AUTHORITY_MISMATCH'),{code:'DEVICE_AGENT_LEDGER_AUTHORITY_MISMATCH',statusCode:403});
}
