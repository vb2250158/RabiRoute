import { createHash } from 'node:crypto';
import type { createDeviceAgentOwner } from '../agentAdapters/deviceAgentOwner.js';
import type { AgentThreadRequest } from '../agentThreads.js';
import type { AgentRequestEndpoint } from '../agentRequests/endpoint.js';
import { sameAgentEndpoint } from '../agentRequests/endpoint.js';
import type { AgentRequestParty } from '../agentRequests/store.js';
import type { PreparedEndpointDelivery, EndpointDeliveryReceipt } from '../agentRequests/endpointDelivery.js';
import type { RabiLinkAgentPrincipal } from './rabiLinkAgentDevices.js';

type Owner = ReturnType<typeof createDeviceAgentOwner>;
export type DeviceAgentEndpointBridgeOptions = {
  managerInstanceId: string;
  ownerInstanceId: string;
  scope(): string;
  owner: Pick<Owner, 'sessions'|'enqueuePrepared'|'readPreparedReceipt'|'waitReceipt'>;
  assertDeviceAssignment(scope: string, agentId: string): Promise<void>;
  peer?: {
    localDeviceId():string;
    targetDeviceId(agentId:string):Promise<string>;
    /** Verified generic Manager HTTP; returns the original JSON body (or its data) and rejects HTTP/connection failures. */
    request(targetDeviceId:string,method:'GET'|'POST',pathname:string,body?:unknown):Promise<unknown>;
  };
};
const failure = (code: string, statusCode=409) => Object.assign(new Error(code),{code,statusCode});

/** Native device identity is supplied by the authenticated connection, never the request body. */
export function createDeviceAgentEndpointBridge(options: DeviceAgentEndpointBridgeOptions) {
  type RemoteProof={scope:string;localDeviceId:string;ownerDeviceId:string;party:AgentRequestParty;loaded:boolean;validUntil:number};
  const proofs=new Map<string,RemoteProof>();
  const key=(agentId:string,sessionId:string)=>agentId+'\n'+sessionId;
  function unwrap(value:any):any {
    if(!value || typeof value!=='object' || (value.code!==undefined && value.code!==0) || value.ok===false)throw failure('DEVICE_AGENT_PEER_RESPONSE_INVALID',502);
    return value.data ?? value;
  }
  function connectionFence() {
    const scope=options.scope(),localDeviceId=options.peer?.localDeviceId();
    if(!scope)throw failure('DEVICE_AGENT_CONNECTION_REQUIRED',503);
    return ()=>{if(options.scope()!==scope || options.peer?.localDeviceId()!==localDeviceId)throw failure('DEVICE_AGENT_CONNECTION_CHANGED',401);};
  }
  function party(agentId: string, sessionId: string, agentType: string): AgentRequestParty {
    const scope=options.scope();
    if(!scope) throw failure('DEVICE_AGENT_CONNECTION_REQUIRED',503);
    const session=options.owner.sessions(scope).find(row=>row.agentId===agentId && row.sessionId===sessionId);
    if(!session) throw failure('DEVICE_AGENT_SESSION_NOT_FOUND',404);
    const endpoint:AgentRequestEndpoint={kind:'device',managerInstanceId:options.managerInstanceId,instanceId:options.ownerInstanceId,
      agentId,provider:'deviceAgent',sessionId,authorizationIncarnation:createHash('sha256').update(JSON.stringify([scope,options.ownerInstanceId,agentId,sessionId,session.ownerEpoch])).digest('hex')};
    return {endpoint,agentAdapter:'deviceAgent',threadId:sessionId,threadName:session.name,agentType};
  }
  function authorize(endpoint: AgentRequestEndpoint,role?:'source'|'target') {
    const requireLoaded=role==='source';
    if(endpoint.kind!=='device' || endpoint.managerInstanceId!==options.managerInstanceId || endpoint.provider!=='deviceAgent')throw failure('DEVICE_AGENT_ENDPOINT_CHANGED',401);
    if(endpoint.instanceId===options.ownerInstanceId) {
      if(!sameAgentEndpoint(endpoint,party(endpoint.agentId,endpoint.sessionId,'agent').endpoint))throw failure('DEVICE_AGENT_ENDPOINT_CHANGED',401);
      if(requireLoaded && !options.owner.sessions(options.scope()).find(row=>row.agentId===endpoint.agentId && row.sessionId===endpoint.sessionId)?.loaded)throw failure('DEVICE_AGENT_NOT_LOADED');
      return;
    }
    const proof=proofs.get(key(endpoint.agentId,endpoint.sessionId));
    if(!proof || proof.scope!==options.scope() || proof.localDeviceId!==options.peer?.localDeviceId() || proof.validUntil<Date.now()
      || !sameAgentEndpoint(endpoint,proof.party.endpoint))throw failure('DEVICE_AGENT_ENDPOINT_CHANGED',401);
    if(requireLoaded && !proof.loaded)throw failure('DEVICE_AGENT_NOT_LOADED');
  }
  async function assignment(scope: string, agentId: string, endpoint: AgentRequestEndpoint) {
    await options.assertDeviceAssignment(scope,agentId);
    if(scope!==options.scope()) throw failure('DEVICE_AGENT_CONNECTION_CHANGED',401);
    authorize(endpoint);
  }
  async function lookup(agentId:string,sessionId:string,type:string):Promise<{party:AgentRequestParty;loaded:boolean}> {
    const fence=connectionFence(),scope=options.scope();
    const local=options.owner.sessions(scope).find(row=>row.agentId===agentId && row.sessionId===sessionId);
    if(local) {
      const selected=party(agentId,sessionId,type);await assignment(scope,agentId,selected.endpoint!);fence();
      return {party:selected,loaded:Boolean(options.owner.sessions(scope).find(row=>row.agentId===agentId && row.sessionId===sessionId)?.loaded)};
    }
    if(!options.peer)throw failure('DEVICE_AGENT_SESSION_NOT_FOUND',404);
    const targetDeviceId=await options.peer.targetDeviceId(agentId);fence();
    if(!targetDeviceId || targetDeviceId===options.peer.localDeviceId())throw failure('DEVICE_AGENT_SESSION_NOT_FOUND',404);
    const response=await options.peer.request(targetDeviceId,'GET','/api/device-agents/'+encodeURIComponent(agentId)+'/session');fence();
    const proof=unwrap(response),session=proof.session;
    if(!session || session.sessionId!==sessionId || typeof session.loaded!=='boolean' || typeof session.ownerEpoch!=='string' || !session.ownerEpoch
      || typeof session.name!=='string' || typeof proof.ownerInstanceId!=='string' || !proof.ownerInstanceId || !/^[a-f0-9]{64}$/.test(proof.authorizationIncarnation))throw failure('DEVICE_AGENT_PEER_SESSION_INVALID',502);
    const endpoint:AgentRequestEndpoint={kind:'device',managerInstanceId:options.managerInstanceId,instanceId:proof.ownerInstanceId,
      agentId,provider:'deviceAgent',sessionId,authorizationIncarnation:proof.authorizationIncarnation};
    const selected:AgentRequestParty={endpoint,agentAdapter:'deviceAgent',threadId:sessionId,threadName:session.name,agentType:type};
    proofs.set(key(agentId,sessionId),{scope,localDeviceId:options.peer.localDeviceId(),ownerDeviceId:targetDeviceId,party:selected,loaded:session.loaded,validUntil:Date.now()+30000});
    return {party:selected,loaded:session.loaded};
  }
  async function refresh(endpoint:AgentRequestEndpoint,role?:'source'|'target') {
    if(endpoint.kind!=='device')return;
    const current=await lookup(endpoint.agentId,endpoint.sessionId,'agent');
    if(!sameAgentEndpoint(current.party.endpoint,endpoint))throw failure('DEVICE_AGENT_ENDPOINT_CHANGED',401);
    authorize(endpoint,role);
  }
  async function resolveSource(request: AgentThreadRequest, principal?: RabiLinkAgentPrincipal): Promise<AgentRequestParty|undefined> {
    if(!principal?.deviceOwner) return undefined;
    if(principal.scope!==options.scope()) throw failure('DEVICE_AGENT_CONNECTION_CHANGED',401);
    if(!request.sourceThreadId || !request.sourceAgentType) throw failure('DEVICE_AGENT_SOURCE_REQUIRED',400);
    const source=await lookup(principal.sourceDeviceId,request.sourceThreadId,request.sourceAgentType);
    if(!source.loaded)throw failure('DEVICE_AGENT_NOT_LOADED');
    return source.party;
  }
  async function resolveTarget(request: AgentThreadRequest): Promise<AgentRequestParty|undefined> {
    if(request.agentAdapter && request.agentAdapter!=='deviceAgent') return undefined;
    const binding=request.instanceBinding,scope=options.scope();
    const sessions=scope ? options.owner.sessions(scope) : [];
    const selected=binding?.instanceId===options.ownerInstanceId ? sessions.find(row=>row.agentId===binding.agentId && row.sessionId===request.threadId)
      : !binding ? sessions.find(row=>row.sessionId===request.threadId) : undefined;
    if(request.agentAdapter!=='deviceAgent' && !selected) return undefined;
    if(binding && binding.instanceId!==options.ownerInstanceId) {
      if(!request.threadId)throw failure('DEVICE_AGENT_SESSION_NOT_FOUND',404);
      const target=await lookup(binding.agentId,request.threadId,request.messageProcessing?.targetAgentType || 'agent');
      if(target.party.endpoint?.instanceId!==binding.instanceId)throw failure('DEVICE_AGENT_ENDPOINT_CHANGED',401);
      return target.party;
    }
    if(!selected) throw failure('DEVICE_AGENT_SESSION_NOT_FOUND',404);
    if(request.agentTargetId && request.agentTargetId!==selected.agentId) throw failure('DEVICE_AGENT_INSTANCE_BINDING_REQUIRED',400);
    const target=party(selected.agentId,selected.sessionId,request.messageProcessing?.targetAgentType || 'agent');
    await assignment(scope,selected.agentId,target.endpoint!);
    return target;
  }
  async function transport(delivery: PreparedEndpointDelivery, guard:()=>void, reconcile: boolean): Promise<EndpointDeliveryReceipt|undefined> {
    const fence=connectionFence();
    await refresh(delivery.target);fence();guard();authorize(delivery.target);
    const scope=options.scope();
    if(delivery.target.instanceId!==options.ownerInstanceId) {
      if(!options.peer)throw failure('DEVICE_AGENT_PEER_UNAVAILABLE',503);
      const proof=proofs.get(key(delivery.target.agentId,delivery.target.sessionId))!;
      const response=await options.peer.request(proof.ownerDeviceId,'POST','/api/device-agents/'+encodeURIComponent(delivery.target.agentId)+'/prepared-deliveries'+(reconcile?'/reconcile':''),
        {ledgerOwnerDeviceId:options.peer.localDeviceId(),delivery});fence();
      await refresh(delivery.source,'source');fence();await refresh(delivery.target,'target');fence();guard();
      return unwrap(response).receipt || undefined;
    }
    await assignment(scope,delivery.target.agentId,delivery.target);guard();
    if(!reconcile) {
      await options.owner.enqueuePrepared(scope,delivery.target.agentId,delivery,()=>{guard();authorize(delivery.target);},options.peer?.localDeviceId());
      guard();
      // Queued or phone-submitted wake is not a native-owner receipt. Wait for the existing claim event.
      await options.owner.waitReceipt(scope,delivery.target.agentId,delivery.deliveryId,12000);
      fence();await refresh(delivery.source,'source');fence();guard();
    }
    return options.owner.readPreparedReceipt(scope,delivery.target.agentId,delivery);
  }
  return {resolveSource,resolveTarget,authorize,transport,refresh};
}
export type DeviceAgentEndpointBridge = ReturnType<typeof createDeviceAgentEndpointBridge>;
