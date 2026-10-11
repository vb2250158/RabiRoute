import path from 'node:path';
import type http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { RabiLinkOwnerStore } from '../manager/rabiLinkOwnerStore.js';
import type { RabiLinkAgentPrincipal } from '../manager/rabiLinkAgentDevices.js';
import { renderRabiDelivery, type RabiDeliveryEnvelope } from '../shared/rabiMessage.js';
import type { InstanceAgent } from '../shared/agentInstance.js';
import type { PreparedEndpointDelivery, EndpointDeliveryReceipt } from '../agentRequests/endpointDelivery.js';
import { sameAgentEndpoint } from '../agentRequests/endpoint.js';
import { agentDeliveryPromptHash } from '../agentRequests/store.js';
import { endpointExecutionOptionsHash } from '../agentRequests/executionOptions.js';
import type { DeviceAgentPreparedInput, DeviceAgentPreparedPrincipal, DeviceAgentPreparedClaimEvidence } from '../manager/deviceAgentPreparedAuthority.js';

export type DeviceAgentOwnerOptions = {
  dataDir: string; ownerInstanceId: string;
  authorize(request: http.IncomingMessage): RabiLinkAgentPrincipal | null;
  /** Authenticated enabled connection scope; route binding only selects automatic delivery. */
  authorizeDelivery(request: http.IncomingMessage, agentId: string): Promise<{ scope: string } | null>;
  /** Signed peer issuer plus a readback of its original Manager ledger reservation, not client-declared authority. */
  authorizePrepared?(request: http.IncomingMessage, agentId: string, input: DeviceAgentPreparedInput): Promise<DeviceAgentPreparedPrincipal | null>;
  authorizePreparedClaim?(request: http.IncomingMessage, agentId: string, evidence:DeviceAgentPreparedClaimEvidence):Promise<void>;
  assertDeviceAssignment(scope: string, agentId: string): Promise<void>;
  now?(): number;
};
type Session = { sessionId: string; name: string; ownerEpoch: string; managerEpoch: string; loaded: boolean; expiresAt: number; capabilities: string[] };
type PreparedTransport = Pick<PreparedEndpointDelivery, 'generation'|'source'|'target'|'promptHash'|'executionOptionsHash'> & { ledgerOwnerDeviceId?: string };
type Delivery = { deliveryId: string; fingerprint: string; envelope: RabiDeliveryEnvelope; prompt: string; prepared?: PreparedTransport; status: 'queued'|'claimed'|'completed'|'failed'|'result-unknown'; createdAt: number; sessionId?: string; ownerEpoch?: string; claimToken?: string; response?: { status: string; text: string; errorCode?: string }; wake: { nonce: string; status: 'pending'|'claimed'|'submitted'|'failed'; claimToken?: string; errorCode?: string } };
type Agent = { session: Session | null; deliveries: Delivery[] };
type Store = { version: 1; agents: Record<string, Agent> };
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value) || ['__proto__','constructor','prototype'].includes(value)) throw failure('DEVICE_AGENT_ID_INVALID');
  return value;
};
const failure = (code: string, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const deviceAgentOwnerPath = (pathname: string) => pathname === '/api/device-agents' || pathname.startsWith('/api/device-agents/');

/** PC owns durable delivery and receipt state; the device's loaded model remains the only executor. */
export function createDeviceAgentOwner(options: DeviceAgentOwnerOptions) {
  const now = options.now || Date.now, managerEpoch = randomUUID();
  const listeners = new Map<string, Set<() => void>>();
  const changeListeners = new Set<() => void>();
  const resource = new RabiLinkOwnerStore<Store>(path.join(options.dataDir, 'device-agent-owner'), () => ({ version: 1, agents: {} }), value => {
    const stored = value as Store;
    if (stored?.version !== 1 || !stored.agents || Array.isArray(stored.agents)) throw failure('DEVICE_AGENT_STORE_INVALID', 500);
    for (const [key, agent] of Object.entries(stored.agents)) {
      id(key);
      if (!Array.isArray(agent.deliveries) || agent.deliveries.length > 1024) throw failure('DEVICE_AGENT_STORE_INVALID', 500);
      if (agent.session && (typeof agent.session.sessionId !== 'string' || typeof agent.session.ownerEpoch !== 'string' || typeof agent.session.loaded !== 'boolean' || !Number.isFinite(agent.session.expiresAt))) throw failure('DEVICE_AGENT_STORE_INVALID',500);
      const seen = new Set<string>();
      for (const row of agent.deliveries) {
        if (!row.deliveryId || seen.has(row.deliveryId) || !/^[a-f0-9]{64}$/.test(row.fingerprint) || typeof row.prompt !== 'string' || row.prompt.length>262144 || !row.envelope?.messageSource || !row.wake?.nonce
          || !['queued','claimed','completed','failed','result-unknown'].includes(row.status) || !['pending','claimed','submitted','failed'].includes(row.wake.status)) throw failure('DEVICE_AGENT_STORE_INVALID', 500);
        seen.add(row.deliveryId);
        if(row.prepared && (!row.sessionId || !row.ownerEpoch || row.prepared.target.kind!=='device' || row.prepared.target.agentId!==key || row.prepared.target.sessionId!==row.sessionId
          || row.prepared.target.provider!=='deviceAgent' || row.prepared.target.instanceId!==options.ownerInstanceId || !row.prepared.generation
          || row.prepared.promptHash!==agentDeliveryPromptHash(row.prompt) || !/^[a-f0-9]{64}$/.test(row.prepared.executionOptionsHash))) throw failure('DEVICE_AGENT_STORE_INVALID',500);
      }
    }
    return stored;
  });
  const live = (session: Session | null) => Boolean(session?.loaded && session.managerEpoch === managerEpoch && session.expiresAt > now());
  const save = (scope: string, stored: Store) => { resource.write(scope, stored); for(const changed of listeners.get(scope) || []) changed(); for(const changed of changeListeners) {try{changed();}catch{/* Observer failure cannot undo a durable owner claim. */}} };
  const agentIn = (stored: Store, agentId: string) => Object.hasOwn(stored.agents,agentId) ? stored.agents[agentId] : (stored.agents[agentId] = { session: null, deliveries: [] });
  const receipt = (row: Delivery) => ({ deliveryId: row.deliveryId, status: row.status, sessionId: row.sessionId || null, ownerEpoch: row.ownerEpoch || null,
    ownerAccepted: ['claimed','completed','failed'].includes(row.status), response: row.response || null, wake: { status: row.wake.status, errorCode: row.wake.errorCode || null } });
  function agents(scope: string): InstanceAgent[] {
    return Object.entries(resource.read(scope).agents).map(([agentId, agent]) => ({ agentId, name: agent.session?.name || agentId, provider: 'deviceAgent', enabled: true,
      sessionId: agent.session?.sessionId, model: 'device-host', configRevision: agent.session?.ownerEpoch, routeId: undefined,
      ...{ loaded: live(agent.session), capabilities: agent.session?.capabilities || [], ownerInstanceId: options.ownerInstanceId } }));
  }
  function readDelivery(scope: string, agentId: string, deliveryId: string) {
    const stored=resource.read(scope), agent=Object.hasOwn(stored.agents,agentId) ? stored.agents[agentId] : undefined;
    const row = agent?.deliveries.find(row => row.deliveryId === deliveryId);
    return row ? receipt(row) : null;
  }
  function sessions(scope: string) { return Object.entries(resource.read(scope).agents).flatMap(([agentId,agent]) => agent.session ? [{agentId,sessionId:agent.session.sessionId,name:agent.session.name,loaded:live(agent.session),ownerEpoch:agent.session.ownerEpoch,updatedAt:new Date(agent.session.expiresAt-45000).toISOString()}] : []); }
  function readSession(scope: string, agentId: string, sessionId: string) {
    const stored=resource.read(scope), agent=Object.hasOwn(stored.agents,agentId) ? stored.agents[agentId] : undefined;
    if(agent?.session?.sessionId!==sessionId) return null;
    return {...sessions(scope).find(row=>row.agentId===agentId),deliveries:agent.deliveries.filter(row=>row.sessionId===sessionId).map(row=>({...receipt(row),envelope:structuredClone(row.envelope),prompt:row.prompt}))};
  }
  async function enqueueRecord(scope: string, agentId: string, envelope: RabiDeliveryEnvelope, prompt: string, fingerprint: string,
    assertAuthority: () => Promise<void>, prepared?: PreparedTransport, assertWrite?:()=>void) {
    id(agentId); const deliveryId=id(envelope.deliveryId);
    await options.assertDeviceAssignment(scope,agentId); await assertAuthority();
    assertWrite?.(); // Recheck the original ledger lease synchronously after all assignment/authentication awaits.
    const stored=resource.read(scope),agent=agentIn(stored,agentId);
    const previous=agent.deliveries.find(row=>row.deliveryId===deliveryId);
    if(previous) { if(previous.fingerprint!==fingerprint) throw failure('DEVICE_AGENT_DELIVERY_CONFLICT',409); return receipt(previous); }
    if(prepared && (!agent.session || agent.session.sessionId!==prepared.target.sessionId
      || prepared.target.authorizationIncarnation!==hash([scope,options.ownerInstanceId,agentId,agent.session.sessionId,agent.session.ownerEpoch]))) throw failure('DEVICE_AGENT_ENDPOINT_CHANGED',409);
    if(agent.deliveries.length>=1024) throw failure('DEVICE_AGENT_JOURNAL_CAPACITY',409);
    const row: Delivery={deliveryId,fingerprint,envelope:structuredClone(envelope),prompt,status:'queued',createdAt:now(),wake:{nonce:randomUUID(),status:'pending'},
      ...(prepared ? {prepared:structuredClone(prepared),sessionId:agent.session!.sessionId,ownerEpoch:agent.session!.ownerEpoch} : {})};
    if(row.prompt.length>262144) throw failure('DEVICE_AGENT_PROMPT_TOO_LARGE',413);
    agent.deliveries.push(row);save(scope,stored);return receipt(row);
  }
  async function enqueue(scope: string, agentId: string, envelope: RabiDeliveryEnvelope, assertAuthority: () => Promise<void>) {
    id(agentId); id(envelope?.deliveryId);
    if(typeof envelope.messageContent!=='string' || envelope.messageContent.length>131072 || !envelope.messageSource || !['agent','plan','message_adapter','system'].includes(envelope.messageSource.type)
      || [envelope.contextBlocks,envelope.controlBlocks].some(blocks=>blocks!==undefined && (!Array.isArray(blocks) || blocks.length>64 || blocks.some(block=>typeof block!=='string' || block.length>131072)))) throw failure('DEVICE_AGENT_ENVELOPE_INVALID');
    let prompt: string;
    try {prompt=renderRabiDelivery(envelope);} catch {throw failure('DEVICE_AGENT_ENVELOPE_INVALID');}
    return enqueueRecord(scope,agentId,envelope,prompt,hash([agentId,envelope]),assertAuthority);
  }
  async function enqueuePrepared(scope: string, agentId: string, delivery: PreparedEndpointDelivery, assertAuthority: () => void, ledgerOwnerDeviceId?: string) {
    assertAuthority();
    if(delivery.target.kind!=='device' || delivery.target.provider!=='deviceAgent' || delivery.target.agentId!==agentId || delivery.target.instanceId!==options.ownerInstanceId
      || delivery.state!=='dispatching' || delivery.promptHash!==agentDeliveryPromptHash(delivery.prompt) || delivery.executionOptionsHash!==endpointExecutionOptionsHash(delivery.executionOptions)) throw failure('DEVICE_AGENT_PREPARED_INVALID',409);
    const source=delivery.preparation.source;
    const envelope:RabiDeliveryEnvelope={deliveryId:delivery.deliveryId,messageSource:{type:'agent',agentAdapter:source.agentAdapter!,sessionId:source.threadId,sessionName:source.threadName || delivery.source.agentId},messageContent:delivery.prompt};
    const prepared:PreparedTransport={generation:delivery.generation,source:delivery.source,target:delivery.target,promptHash:delivery.promptHash,executionOptionsHash:delivery.executionOptionsHash,
      ...(ledgerOwnerDeviceId ? {ledgerOwnerDeviceId:id(ledgerOwnerDeviceId)} : {})};
    return enqueueRecord(scope,agentId,envelope,delivery.prompt,hash([agentId,prepared]),async()=>assertAuthority(),prepared,assertAuthority);
  }
  function readPreparedReceipt(scope: string, agentId: string, delivery: PreparedEndpointDelivery): EndpointDeliveryReceipt | undefined {
    const stored=resource.read(scope),row=Object.hasOwn(stored.agents,agentId) ? stored.agents[agentId].deliveries.find(row=>row.deliveryId===delivery.deliveryId) : undefined;
    if(!row) return undefined;
    if(!row.prepared || !sameAgentEndpoint(row.prepared.source,delivery.source) || !sameAgentEndpoint(row.prepared.target,delivery.target) || row.prepared.generation!==delivery.generation || row.prepared.promptHash!==delivery.promptHash
      || row.prepared.executionOptionsHash!==delivery.executionOptionsHash) throw failure('DEVICE_AGENT_PREPARED_CONFLICT',409);
    if(!receipt(row).ownerAccepted) return undefined;
    if(row.sessionId!==delivery.target.sessionId || !row.claimToken) throw failure('DEVICE_AGENT_CLAIM_MISMATCH',409);
    return {deliveryId:row.deliveryId,generation:row.prepared.generation,promptHash:row.prepared.promptHash,executionOptionsHash:row.prepared.executionOptionsHash,
      endpoint:row.prepared.target,accepted:true,action:'claimed',transport:'device-mailbox'};
  }
  async function waitChange(scope: string, waitMs: number) {
    if(!waitMs) return;
    await new Promise<void>(resolve=>{
      const pending=listeners.get(scope) || new Set<()=>void>(); listeners.set(scope,pending);
      let timer: ReturnType<typeof setTimeout>;
      const done=()=>{clearTimeout(timer);pending.delete(done);if(!pending.size)listeners.delete(scope);resolve();};
      pending.add(done);timer=setTimeout(done,Math.min(12000,Math.max(0,waitMs)));
    });
  }
  async function waitReceipt(scope: string, agentId: string, deliveryId: string, waitMs: number) {
    const deadline=Date.now()+Math.min(12000,Math.max(0,waitMs));
    while(true) {
      const current=readDelivery(scope,agentId,deliveryId),remaining=deadline-Date.now();
      if(!current || current.ownerAccepted || current.status==='result-unknown' || current.wake.status==='failed' || remaining<=0)return current;
      // Other deliveries and lease renewals share this scope's event; only the original receipt ends the wait.
      await waitChange(scope,remaining);
    }
  }
  return { agents, sessions, readSession, enqueue, enqueuePrepared, readPreparedReceipt, readDelivery, waitReceipt,
    onChange(listener:()=>void) {changeListeners.add(listener);return ()=>{changeListeners.delete(listener);};},
    async handle(request: http.IncomingMessage, response: http.ServerResponse, url: URL, body: any): Promise<boolean> {
      if (!deviceAgentOwnerPath(url.pathname)) return false;
      const send = (statusCode: number, data: unknown) => { response.writeHead(statusCode, {'content-type':'application/json','cache-control':'no-store'}); response.end(JSON.stringify({code:0,data})); };
      try {
        const parts = url.pathname.slice('/api/device-agents'.length).split('/').filter(Boolean).map(decodeURIComponent);
        const method = request.method || 'GET';
        const principal = options.authorize(request);
        if (parts.length === 0) {
          if (!principal) throw failure('DEVICE_AGENT_AUTH_REQUIRED',401);
          if (method !== 'GET') throw failure('METHOD_NOT_ALLOWED',405);
          send(200,{agents:agents(principal.scope),ownerInstanceId:options.ownerInstanceId}); return true;
        }
        const agentId = id(parts[0]);
        const preparedOperation=parts[1]==='prepared-deliveries' && method==='POST' && (parts.length===2 || (parts.length===3 && parts[2]==='reconcile'));
        if(preparedOperation) {
          const input=body as DeviceAgentPreparedInput;
          const original=options.authorize(request),authority=await options.authorizePrepared?.(request,agentId,input);
          if(!original || !authority || authority.scope!==original.scope || authority.ledgerOwnerDeviceId!==input?.ledgerOwnerDeviceId) throw failure('DEVICE_AGENT_PREPARED_AUTH_REQUIRED',403);
          const fence=()=>{const current=options.authorize(request);if(!current || hash(current)!==hash(original))throw failure('DEVICE_AGENT_CONNECTION_CHANGED',401);};
          fence();await options.assertDeviceAssignment(authority.scope,agentId);fence();
          const refreshed=await options.authorizePrepared?.(request,agentId,input);fence();
          if(!refreshed || hash(refreshed)!==hash(authority))throw failure('DEVICE_AGENT_PREPARED_AUTH_CHANGED',403);
          if(parts.length===2) {
            await enqueuePrepared(authority.scope,agentId,input.delivery,fence,authority.ledgerOwnerDeviceId);fence();
            await waitReceipt(authority.scope,agentId,input.delivery.deliveryId,12000);fence();
          }
          const result=readPreparedReceipt(authority.scope,agentId,input.delivery);
          send(result?200:202,{receipt:result || null});return true;
        }
        const routeDelivery = parts[1] === 'deliveries' && method === 'POST' && parts.length === 2;
        const managedReceipt=parts[1]==='deliveries' && parts.length===3 && method==='GET' && !principal;
        const authority = routeDelivery || managedReceipt ? await options.authorizeDelivery(request,agentId) : principal;
        if (!authority) throw failure('DEVICE_AGENT_AUTH_REQUIRED',401);
        await options.assertDeviceAssignment(authority.scope,agentId);
        // Recheck connection after asynchronous assignment lookup, before reading or mutating its scope.
        if (routeDelivery || managedReceipt) {
          const fresh=await options.authorizeDelivery(request,agentId);
          if(!fresh || hash(fresh)!==hash(authority)) throw failure('DEVICE_AGENT_ROUTE_AUTH_CHANGED',403);
        } else {
          const fresh = options.authorize(request);
          if (!fresh || fresh.scope !== authority.scope || fresh.sourceDeviceId !== principal?.sourceDeviceId || fresh.deviceOwner !== principal?.deviceOwner) throw failure('DEVICE_AGENT_CONNECTION_CHANGED',401);
        }
        const scope = authority.scope, stored = resource.read(scope), agent = agentIn(stored,agentId);
        const requireDevice = () => { if (!principal?.deviceOwner || principal.sourceDeviceId !== agentId) throw failure('DEVICE_AGENT_OWNER_REQUIRED',403); };
        const currentSession = () => {
          requireDevice();
          const session = agent.session;
          if (!session || !live(session) || body?.sessionId !== session.sessionId || body?.ownerEpoch !== session.ownerEpoch) throw failure('DEVICE_AGENT_NOT_LOADED',409);
          return session;
        };
        if (parts[1] === 'session' && parts.length === 2) {
          if (method === 'GET') { send(200,{ownerInstanceId:options.ownerInstanceId,authorizationIncarnation:agent.session ? hash([scope,options.ownerInstanceId,agentId,agent.session.sessionId,agent.session.ownerEpoch]) : null,
            session:agent.session ? {...agent.session,loaded:live(agent.session)} : null}); return true; }
          requireDevice();
          if (method !== 'PUT') throw failure('METHOD_NOT_ALLOWED',405);
          const sessionId = id(body?.sessionId), name = String(body?.name || '').trim();
          if (!name || name.length > 160 || typeof body.loaded !== 'boolean' || !Array.isArray(body.capabilities) || body.capabilities.some((value: unknown) => typeof value !== 'string' || value.length > 80)) throw failure('DEVICE_AGENT_SESSION_INVALID');
          if (live(agent.session) && (sessionId !== agent.session!.sessionId || body.ownerEpoch !== agent.session!.ownerEpoch)) throw failure('DEVICE_AGENT_OWNER_ALREADY_LOADED',409);
          const same = agent.session?.sessionId === sessionId && agent.session.managerEpoch === managerEpoch && body.ownerEpoch === agent.session.ownerEpoch;
          if (!same) for (const row of agent.deliveries) if (row.status === 'claimed' || (row.prepared && row.status==='queued')) row.status = 'result-unknown';
          agent.session = {sessionId,name,ownerEpoch:same ? agent.session!.ownerEpoch : randomUUID(),managerEpoch,loaded:body.loaded,expiresAt:now()+45000,capabilities:[...new Set(body.capabilities as string[])].slice(0,16)};
          save(scope,stored); send(200,{session:agent.session}); return true;
        }
        if(parts[1]==='pending' && parts.length===2 && method==='GET') {
          if(!agent.deliveries.some(row=>row.status==='queued')) await waitChange(scope,Number(url.searchParams.get('waitMs') || 0));
          const fresh=options.authorize(request);
          if(!fresh || fresh.scope!==scope || fresh.sourceDeviceId!==principal?.sourceDeviceId)throw failure('DEVICE_AGENT_CONNECTION_CHANGED',401);
          const latest=resource.read(scope).agents[agentId];
          send(200,{pending:latest?.deliveries.some(row=>row.status==='queued') || false});return true;
        }
        if (routeDelivery) {
          const envelope = body?.envelope as RabiDeliveryEnvelope, deliveryId = id(body?.deliveryId);
          if (!envelope || envelope.deliveryId !== deliveryId) throw failure('DEVICE_AGENT_ENVELOPE_INVALID');
          const result=await enqueue(scope,agentId,envelope,async()=>{const fresh=await options.authorizeDelivery(request,agentId);if(!fresh || hash(fresh)!==hash(authority))throw failure('DEVICE_AGENT_ROUTE_AUTH_CHANGED',403);});
          send(result.ownerAccepted?200:202,{receipt:result});return true;
        }
        if (parts[1] === 'wake-requests') {
          if (method === 'GET' && parts.length === 2) {
            const pending=(selected:Agent|undefined)=>selected?.deliveries.filter(row => row.status === 'queued' && row.wake.status === 'pending' && !live(selected.session)).map(row=>({agentId,nonce:row.wake.nonce,deliveryId:row.deliveryId})) || [];
            if(!pending(agent).length)await waitChange(scope,Number(url.searchParams.get('waitMs') || 0));
            const fresh=options.authorize(request);if(!fresh || fresh.scope!==scope || fresh.sourceDeviceId!==principal?.sourceDeviceId)throw failure('DEVICE_AGENT_CONNECTION_CHANGED',401);
            send(200,{requests:pending(resource.read(scope).agents[agentId])});return true;
          }
          const row = agent.deliveries.find(row => row.wake.nonce === parts[2]);
          if (!row || method !== 'POST' || parts.length!==4) throw failure('DEVICE_AGENT_WAKE_NOT_FOUND',404);
          if (parts[3] === 'claim') {
            if (row.wake.status !== 'pending') throw failure('DEVICE_AGENT_WAKE_ALREADY_CLAIMED',409);
            row.wake.status='claimed'; row.wake.claimToken=randomUUID(); save(scope,stored); send(200,{nonce:row.wake.nonce,claimToken:row.wake.claimToken}); return true;
          }
          if (parts[3] === 'receipt') {
            if (body?.claimToken !== row.wake.claimToken || !['submitted','failed'].includes(body?.status)) throw failure('DEVICE_AGENT_WAKE_RECEIPT_INVALID',409);
            if (row.wake.status !== 'claimed' && row.wake.status !== body.status) throw failure('DEVICE_AGENT_WAKE_RECEIPT_CONFLICT',409);
            row.wake.status=body.status; row.wake.errorCode=String(body.errorCode || '').slice(0,120); save(scope,stored); send(200,{receipt:receipt(row)}); return true;
          }
        }
        if (parts[1] === 'deliveries' && parts[2] === 'claim' && method === 'POST' && parts.length===3) {
          const session=currentSession();
          // One live owner cannot start another Route turn before settling the first.
          const active=agent.deliveries.find(row=>row.status==='claimed' && row.ownerEpoch===session.ownerEpoch);
          if (active) { send(200,{delivery:null,activeReceipt:receipt(active)}); return true; }
          let claimStore=stored,claimAgent=agent;
          let row=agent.deliveries.find(row=>row.status==='queued');
          if(!row) { send(200,{delivery:null}); return true; }
          if(row.prepared && (row.sessionId!==session.sessionId || row.ownerEpoch!==session.ownerEpoch)) throw failure('DEVICE_AGENT_PREPARED_OWNER_CHANGED',409);
          if(row.prepared?.ledgerOwnerDeviceId) {
            if(!options.authorizePreparedClaim) throw failure('DEVICE_AGENT_LEDGER_AUTHORITY_REQUIRED',503);
            const originalId=row.deliveryId,originalFingerprint=row.fingerprint;
            let ledgerCancelled=false;
            try {await options.authorizePreparedClaim(request,agentId,{deliveryId:row.deliveryId,...row.prepared,ledgerOwnerDeviceId:row.prepared.ledgerOwnerDeviceId});}
            catch(error:any) {if(error.code!=='DEVICE_AGENT_LEDGER_CANCELLED')throw error;ledgerCancelled=true;}
            const fresh=options.authorize(request);
            if(!fresh || hash(fresh)!==hash(principal))throw failure('DEVICE_AGENT_CONNECTION_CHANGED',401);
            claimStore=resource.read(scope);claimAgent=agentIn(claimStore,agentId);
            if(!live(claimAgent.session) || claimAgent.session?.sessionId!==session.sessionId || claimAgent.session?.ownerEpoch!==session.ownerEpoch)throw failure('DEVICE_AGENT_PREPARED_OWNER_CHANGED',409);
            const newlyActive=claimAgent.deliveries.find(row=>row.status==='claimed' && row.ownerEpoch===session.ownerEpoch);
            if(newlyActive){send(200,{delivery:null,activeReceipt:receipt(newlyActive)});return true;}
            row=claimAgent.deliveries.find(row=>row.deliveryId===originalId);
            if(!row || row.status!=='queued' || row.fingerprint!==originalFingerprint)throw failure('DEVICE_AGENT_DELIVERY_CHANGED',409);
            if(ledgerCancelled) {
              row.status='result-unknown';row.response={status:'result-unknown',text:'',errorCode:'ledger_cancelled'};save(scope,claimStore);
              send(200,{delivery:null,cancelledReceipt:receipt(row)});return true;
            }
          }
          row.status='claimed'; row.sessionId=session.sessionId; row.ownerEpoch=session.ownerEpoch; row.claimToken=randomUUID(); save(scope,claimStore);
          send(200,{delivery:{deliveryId:row.deliveryId,prompt:row.prompt,envelope:row.envelope,sessionId:row.sessionId,ownerEpoch:row.ownerEpoch,claimToken:row.claimToken,
            ...(row.prepared?.ledgerOwnerDeviceId ? {ledgerOwnerDeviceId:row.prepared.ledgerOwnerDeviceId} : {})}}); return true;
        }
        if (parts[1] === 'deliveries' && parts[2]) {
          const row=agent.deliveries.find(row=>row.deliveryId===parts[2]);
          if(!row) throw failure('DEVICE_AGENT_DELIVERY_NOT_FOUND',404);
          if (method==='GET' && parts.length===3) {
            const result=await waitReceipt(scope,agentId,row.deliveryId,Number(url.searchParams.get('waitMs') || 0));
            if(managedReceipt) {const fresh=await options.authorizeDelivery(request,agentId);if(!fresh || hash(fresh)!==hash(authority))throw failure('DEVICE_AGENT_ROUTE_AUTH_CHANGED',403);}
            else {const fresh=options.authorize(request);if(!fresh || fresh.scope!==scope || fresh.sourceDeviceId!==principal?.sourceDeviceId)throw failure('DEVICE_AGENT_CONNECTION_CHANGED',401);}
            send(200,{receipt:result});return true;
          }
          if (method==='POST' && parts[3]==='response' && parts.length===4) {
            currentSession();
            if(row.sessionId!==body.sessionId || row.ownerEpoch!==body.ownerEpoch || row.claimToken!==body.claimToken) throw failure('DEVICE_AGENT_CLAIM_MISMATCH',409);
            if(!['completed','failed','result-unknown'].includes(body.status) || typeof body.text!=='string' || body.text.length>32768) throw failure('DEVICE_AGENT_RESPONSE_INVALID');
            const result={status:body.status,text:body.text,...(body.errorCode ? {errorCode:String(body.errorCode).slice(0,120)} : {})};
            if(row.response && hash(row.response)!==hash(result)) throw failure('DEVICE_AGENT_RESPONSE_CONFLICT',409);
            row.response=result; row.status=body.status; save(scope,stored); send(200,{receipt:receipt(row)}); return true;
          }
        }
        throw failure('DEVICE_AGENT_PATH_NOT_FOUND',404);
      } catch (error: any) {
        response.writeHead(error.statusCode || 500,{'content-type':'application/json','cache-control':'no-store'}); response.end(JSON.stringify({code:error.code || 'DEVICE_AGENT_INTERNAL_ERROR',message:error.code || 'DEVICE_AGENT_INTERNAL_ERROR'})); return true;
      }
    }
  };
}
