import { getTimeoutMs } from "../shared/timeoutSettings.js";
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
  assertCurrent?(): void;
  connectionContextAvailable?(): boolean;
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
  if (typeof value !== 'string' || !deviceIdPattern.test(value) || ['__proto__','constructor','prototype'].includes(value)) throw failure('DEVICE_AGENT_ID_INVALID');
  return value;
};
const failure = (code: string, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const DEVICE_AGENT_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$';
export const DEVICE_AGENT_LIMITS = Object.freeze({ deliveries: 1024, prompt: 262144, message: 131072, blocks: 64, response: 32768, sessionName: 160, capabilities: 16, capabilityText: 80, errorCode: 120, leaseMs: 45000, get waitMs() { return getTimeoutMs("agent.deviceWait", 12000); } });
const deviceIdPattern = new RegExp(DEVICE_AGENT_ID_PATTERN);
export type DeviceAgentAction = 'directory' | 'sessionRead' | 'sessionPublish' | 'pending' | 'deliveryEnqueue' | 'wakeList' | 'wakeClaim' | 'wakeReceipt' | 'deliveryClaim' | 'deliveryRead' | 'deliveryResponse' | 'preparedEnqueue' | 'preparedReconcile';
export type DeviceAgentOperationResult = { status: number; data: unknown };

/** PC owns durable delivery and receipt state; the device's loaded model remains the only executor. */
export function createDeviceAgentOwner(options: DeviceAgentOwnerOptions) {
  const now = options.now || Date.now, managerEpoch = randomUUID();
  const listeners = new Map<string, Set<() => void>>();
  const changeListeners = new Set<() => void>();
  // Keep the original raw rows in the original store. Only views and access to
  // the damaged agent are isolated; healthy writes retain every quarantined row.
  const isolated = new WeakMap<Store, Set<string>>();
  const validateAgent = (key: string, agent: Agent) => {
      id(key);
      if (!agent || typeof agent !== 'object' || !Array.isArray(agent.deliveries) || agent.deliveries.length > DEVICE_AGENT_LIMITS.deliveries) throw failure('DEVICE_AGENT_STORE_INVALID', 500);
      if (agent.session !== null && (!agent.session || typeof agent.session !== 'object' || typeof agent.session.sessionId !== 'string' || typeof agent.session.ownerEpoch !== 'string' || typeof agent.session.loaded !== 'boolean' || !Number.isFinite(agent.session.expiresAt))) throw failure('DEVICE_AGENT_STORE_INVALID',500);
      if (agent.session) {
        id(agent.session.sessionId);
        if (typeof agent.session.name !== 'string' || !agent.session.name || agent.session.name.length > DEVICE_AGENT_LIMITS.sessionName
          || typeof agent.session.managerEpoch !== 'string' || !Array.isArray(agent.session.capabilities)
          || agent.session.capabilities.length > DEVICE_AGENT_LIMITS.capabilities || agent.session.capabilities.some(value => typeof value !== 'string' || value.length > DEVICE_AGENT_LIMITS.capabilityText)
          || Number.isNaN(new Date(agent.session.expiresAt - DEVICE_AGENT_LIMITS.leaseMs).getTime())) throw failure('DEVICE_AGENT_STORE_INVALID',500);
      }
      const seen = new Set<string>();
      for (const row of agent.deliveries) {
        if (!row || !row.deliveryId || seen.has(row.deliveryId) || !/^[a-f0-9]{64}$/.test(row.fingerprint) || typeof row.prompt !== 'string' || row.prompt.length>DEVICE_AGENT_LIMITS.prompt || !row.envelope?.messageSource || !row.wake?.nonce
          || !['queued','claimed','completed','failed','result-unknown'].includes(row.status) || !['pending','claimed','submitted','failed'].includes(row.wake.status)) throw failure('DEVICE_AGENT_STORE_INVALID', 500);
        id(row.deliveryId);
        if (row.response && (typeof row.response.status !== 'string' || typeof row.response.text !== 'string' || row.response.text.length > DEVICE_AGENT_LIMITS.response
          || row.response.errorCode !== undefined && typeof row.response.errorCode !== 'string')
          || row.sessionId !== undefined && typeof row.sessionId !== 'string' || row.ownerEpoch !== undefined && typeof row.ownerEpoch !== 'string'
          || row.wake.errorCode !== undefined && typeof row.wake.errorCode !== 'string') throw failure('DEVICE_AGENT_STORE_INVALID',500);
        seen.add(row.deliveryId);
        if(row.prepared && (!row.sessionId || !row.ownerEpoch || row.prepared.target.kind!=='device' || row.prepared.target.agentId!==key || row.prepared.target.sessionId!==row.sessionId
          || row.prepared.target.provider!=='deviceAgent' || row.prepared.target.instanceId!==options.ownerInstanceId || !row.prepared.generation
          || row.prepared.promptHash!==agentDeliveryPromptHash(row.prompt) || !/^[a-f0-9]{64}$/.test(row.prepared.executionOptionsHash))) throw failure('DEVICE_AGENT_STORE_INVALID',500);
      }
  };
  const resource = new RabiLinkOwnerStore<Store>(path.join(options.dataDir, 'device-agent-owner'), () => ({ version: 1, agents: {} }), value => {
    const stored = value as Store;
    if (stored?.version !== 1 || !stored.agents || typeof stored.agents !== 'object' || Array.isArray(stored.agents)) throw failure('DEVICE_AGENT_STORE_INVALID', 500);
    const bad = new Set<string>();
    for (const [key, agent] of Object.entries(stored.agents)) {
      try { validateAgent(key, agent); } catch { bad.add(key); }
    }
    isolated.set(stored, bad); return stored;
  });
  const readableAgent = (stored: Store, agentId: string): Agent | undefined => {
    if (isolated.get(stored)?.has(agentId)) throw failure('DEVICE_AGENT_RECORD_INVALID', 409);
    return Object.hasOwn(stored.agents, agentId) ? stored.agents[agentId] : undefined;
  };
  const readableEntries = (stored: Store) => Object.entries(stored.agents).filter(([key]) => !isolated.get(stored)?.has(key));
  const recordIssues = (stored: Store) => [...(isolated.get(stored) ?? [])].map(agentId => ({agentId, code:'DEVICE_AGENT_RECORD_INVALID'}));
  const live = (session: Session | null) => Boolean(session?.loaded && session.managerEpoch === managerEpoch && session.expiresAt > now());
  const save = (scope: string, stored: Store) => { options.assertCurrent?.(); for (const [key, agent] of readableEntries(stored)) validateAgent(key, agent); resource.write(scope, stored); for(const changed of listeners.get(scope) || []) changed(); for(const changed of changeListeners) {try{changed();}catch{/* Observer failure cannot undo a durable owner claim. */}} };
  const agentIn = (stored: Store, agentId: string) => readableAgent(stored,agentId) ?? (stored.agents[agentId] = { session: null, deliveries: [] });
  const receipt = (row: Delivery) => ({ deliveryId: row.deliveryId, status: row.status, sessionId: row.sessionId || null, ownerEpoch: row.ownerEpoch || null,
    ownerAccepted: ['claimed','completed','failed'].includes(row.status), response: row.response || null, wake: { status: row.wake.status, errorCode: row.wake.errorCode || null } });
  function agents(scope: string, stored = resource.read(scope)): InstanceAgent[] {
    return readableEntries(stored).map(([agentId, agent]) => ({ agentId, name: agent.session?.name || agentId, provider: 'deviceAgent', enabled: true,
      sessionId: agent.session?.sessionId, model: 'device-host', configRevision: agent.session?.ownerEpoch, routeId: undefined,
      ...{ loaded: live(agent.session), capabilities: agent.session?.capabilities || [], ownerInstanceId: options.ownerInstanceId } }));
  }
  function readDelivery(scope: string, agentId: string, deliveryId: string) {
    const stored=resource.read(scope), agent=readableAgent(stored,agentId);
    const row = agent?.deliveries.find(row => row.deliveryId === deliveryId);
    return row ? receipt(row) : null;
  }
  function sessions(scope: string) { return readableEntries(resource.read(scope)).flatMap(([agentId,agent]) => agent.session ? [{agentId,sessionId:agent.session.sessionId,name:agent.session.name,loaded:live(agent.session),ownerEpoch:agent.session.ownerEpoch,updatedAt:new Date(agent.session.expiresAt-DEVICE_AGENT_LIMITS.leaseMs).toISOString()}] : []); }
  function readSession(scope: string, agentId: string, sessionId: string) {
    const stored=resource.read(scope), agent=readableAgent(stored,agentId);
    if(agent?.session?.sessionId!==sessionId) return null;
    return {...sessions(scope).find(row=>row.agentId===agentId),deliveries:agent.deliveries.filter(row=>row.sessionId===sessionId).map(row=>({...receipt(row),envelope:structuredClone(row.envelope),prompt:row.prompt}))};
  }
  async function enqueueRecord(scope: string, agentId: string, envelope: RabiDeliveryEnvelope, prompt: string, fingerprint: string,
    assertAuthority: () => Promise<void>, prepared?: PreparedTransport, assertWrite?:()=>void, onWrite?:()=>void) {
    id(agentId); const deliveryId=id(envelope.deliveryId);
    await options.assertDeviceAssignment(scope,agentId); await assertAuthority();
    assertWrite?.(); // Recheck the original ledger lease synchronously after all assignment/authentication awaits.
    const stored=resource.read(scope),agent=agentIn(stored,agentId);
    const previous=agent.deliveries.find(row=>row.deliveryId===deliveryId);
    if(previous) { if(previous.fingerprint!==fingerprint) throw failure('DEVICE_AGENT_DELIVERY_CONFLICT',409); return receipt(previous); }
    if(prepared && (!agent.session || agent.session.sessionId!==prepared.target.sessionId
      || prepared.target.authorizationIncarnation!==hash([scope,options.ownerInstanceId,agentId,agent.session.sessionId,agent.session.ownerEpoch]))) throw failure('DEVICE_AGENT_ENDPOINT_CHANGED',409);
    if(agent.deliveries.length>=DEVICE_AGENT_LIMITS.deliveries) throw failure('DEVICE_AGENT_JOURNAL_CAPACITY',409);
    const row: Delivery={deliveryId,fingerprint,envelope:structuredClone(envelope),prompt,status:'queued',createdAt:now(),wake:{nonce:randomUUID(),status:'pending'},
      ...(prepared ? {prepared:structuredClone(prepared),sessionId:agent.session!.sessionId,ownerEpoch:agent.session!.ownerEpoch} : {})};
    if(row.prompt.length>DEVICE_AGENT_LIMITS.prompt) throw failure('DEVICE_AGENT_PROMPT_TOO_LARGE',413);
    agent.deliveries.push(row);onWrite?.();save(scope,stored);return receipt(row);
  }
  async function enqueue(scope: string, agentId: string, envelope: RabiDeliveryEnvelope, assertAuthority: () => Promise<void>, onWrite?:()=>void) {
    id(agentId); id(envelope?.deliveryId);
    if(typeof envelope.messageContent!=='string' || envelope.messageContent.length>DEVICE_AGENT_LIMITS.message || !envelope.messageSource || !['agent','agent_hook','plan','message_adapter','system'].includes(envelope.messageSource.type)
      || [envelope.contextBlocks,envelope.controlBlocks].some(blocks=>blocks!==undefined && (!Array.isArray(blocks) || blocks.length>DEVICE_AGENT_LIMITS.blocks || blocks.some(block=>typeof block!=='string' || block.length>DEVICE_AGENT_LIMITS.message)))) throw failure('DEVICE_AGENT_ENVELOPE_INVALID');
    let prompt: string;
    try {prompt=renderRabiDelivery(envelope);} catch {throw failure('DEVICE_AGENT_ENVELOPE_INVALID');}
    return enqueueRecord(scope,agentId,envelope,prompt,hash([agentId,envelope]),assertAuthority,undefined,undefined,onWrite);
  }
  async function enqueuePrepared(scope: string, agentId: string, delivery: PreparedEndpointDelivery, assertAuthority: () => void, ledgerOwnerDeviceId?: string, onWrite?:()=>void) {
    assertAuthority();
    if(delivery.target.kind!=='device' || delivery.target.provider!=='deviceAgent' || delivery.target.agentId!==agentId || delivery.target.instanceId!==options.ownerInstanceId
      || delivery.state!=='dispatching' || delivery.promptHash!==agentDeliveryPromptHash(delivery.prompt) || delivery.executionOptionsHash!==endpointExecutionOptionsHash(delivery.executionOptions)) throw failure('DEVICE_AGENT_PREPARED_INVALID',409);
    const source=delivery.preparation.source;
    const envelope:RabiDeliveryEnvelope={deliveryId:delivery.deliveryId,messageSource:{type:'agent',agentAdapter:source.agentAdapter!,sessionId:source.threadId,sessionName:source.threadName || delivery.source.agentId},messageContent:delivery.prompt};
    const prepared:PreparedTransport={generation:delivery.generation,source:delivery.source,target:delivery.target,promptHash:delivery.promptHash,executionOptionsHash:delivery.executionOptionsHash,
      ...(ledgerOwnerDeviceId ? {ledgerOwnerDeviceId:id(ledgerOwnerDeviceId)} : {})};
    return enqueueRecord(scope,agentId,envelope,delivery.prompt,hash([agentId,prepared]),async()=>assertAuthority(),prepared,assertAuthority,onWrite);
  }
  function readPreparedReceipt(scope: string, agentId: string, delivery: PreparedEndpointDelivery): EndpointDeliveryReceipt | undefined {
    const stored=resource.read(scope),row=readableAgent(stored,agentId)?.deliveries.find(row=>row.deliveryId===delivery.deliveryId);
    if(!row) return undefined;
    if(!row.prepared || !sameAgentEndpoint(row.prepared.source,delivery.source) || !sameAgentEndpoint(row.prepared.target,delivery.target) || row.prepared.generation!==delivery.generation || row.prepared.promptHash!==delivery.promptHash
      || row.prepared.executionOptionsHash!==delivery.executionOptionsHash) throw failure('DEVICE_AGENT_PREPARED_CONFLICT',409);
    if(!receipt(row).ownerAccepted) return undefined;
    if(row.sessionId!==delivery.target.sessionId || !row.claimToken) throw failure('DEVICE_AGENT_CLAIM_MISMATCH',409);
    return {deliveryId:row.deliveryId,generation:row.prepared.generation,promptHash:row.prepared.promptHash,executionOptionsHash:row.prepared.executionOptionsHash,
      endpoint:row.prepared.target,accepted:true,action:'claimed',transport:'device-mailbox'};
  }
  async function waitChange(scope: string, waitMs: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if(!waitMs) return;
    await new Promise<void>(resolve=>{
      const pending=listeners.get(scope) || new Set<()=>void>(); listeners.set(scope,pending);
      let timer: ReturnType<typeof setTimeout>;
      const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);pending.delete(done);if(!pending.size)listeners.delete(scope);resolve();};
      pending.add(done);timer=setTimeout(done,Math.min(DEVICE_AGENT_LIMITS.waitMs,Math.max(0,waitMs)));
      signal?.addEventListener('abort',done,{once:true});
    });
  }
  async function waitReceipt(scope: string, agentId: string, deliveryId: string, waitMs: number, signal?: AbortSignal) {
    const deadline=Date.now()+Math.min(DEVICE_AGENT_LIMITS.waitMs,Math.max(0,waitMs || 0));
    while(true) {
      signal?.throwIfAborted();
      const current=readDelivery(scope,agentId,deliveryId),remaining=deadline-Date.now();
      if(!current || current.ownerAccepted || current.status==='result-unknown' || current.wake.status==='failed' || remaining<=0)return current;
      // Other deliveries and lease renewals share this scope's event; only the original receipt ends the wait.
      await waitChange(scope,remaining,signal);
    }
  }
  return { storageDiagnostics: (scope: string) => recordIssues(resource.read(scope)), agents, sessions, readSession, enqueue, enqueuePrepared, readPreparedReceipt, readDelivery, waitReceipt,
    onChange(listener:()=>void) {changeListeners.add(listener);return ()=>{changeListeners.delete(listener);};},
    async prepare(request: http.IncomingMessage, action: DeviceAgentAction, requestedAgentId?: string, signal?: AbortSignal) {
      options.assertCurrent?.(); signal?.throwIfAborted();
      if (options.connectionContextAvailable?.() === false) throw failure('DEVICE_AGENT_CONTEXT_UNAVAILABLE',503);
      const authorized = options.authorize(request), principal = authorized ? Object.freeze({...authorized}) : null;
      const agentId = action === 'directory' ? '' : id(requestedAgentId);
      const preparedOperation = action === 'preparedEnqueue' || action === 'preparedReconcile';
      const routeDelivery = action === 'deliveryEnqueue', managedReceipt = action === 'deliveryRead' && !principal;
      const originalDeliveryAuthority = routeDelivery || managedReceipt ? await options.authorizeDelivery(request,agentId) : principal;
      if ((!originalDeliveryAuthority && !preparedOperation) || (preparedOperation && !principal)) throw failure('DEVICE_AGENT_AUTH_REQUIRED',401);
      const authority = originalDeliveryAuthority ? Object.freeze({...originalDeliveryAuthority}) : null;
      let writeAttempted = false;
      const fenceSync = () => {
        options.assertCurrent?.(); signal?.throwIfAborted();
        const current = options.authorize(request);
        if (hash(current)!==hash(principal)) throw failure('DEVICE_AGENT_CONNECTION_CHANGED',401);
      };
      const fence = async () => {
        fenceSync();
        if(routeDelivery || managedReceipt) {
          const current = await options.authorizeDelivery(request,agentId); fenceSync();
          if(!current || hash(current)!==hash(authority)) throw failure('DEVICE_AGENT_ROUTE_AUTH_CHANGED',403);
        }
      };
      await fence();
      const markWrite = () => { fenceSync(); writeAttempted = true; };
      const commit = (scope:string, stored:Store) => { markWrite(); save(scope,stored); };
      return Object.freeze({
        async execute(body:any, selectors:{nonce?:string;deliveryId?:string;waitMs?:string|null} = {}):Promise<DeviceAgentOperationResult> {
          const completed = (status:number, data:unknown):DeviceAgentOperationResult => ({status,data});
          try {
            await fence();
            const execute = async ():Promise<DeviceAgentOperationResult> => {
              if(action === 'directory') { const stored = resource.read(principal!.scope); return completed(200,{agents:agents(principal!.scope,stored),recordIssues:recordIssues(stored),ownerInstanceId:options.ownerInstanceId}); }
              if(preparedOperation) {
                const input=body as DeviceAgentPreparedInput;
                const preparedAuthority=await options.authorizePrepared?.(request,agentId,input); await fence();
                if(!preparedAuthority || preparedAuthority.scope!==principal!.scope || preparedAuthority.ledgerOwnerDeviceId!==input?.ledgerOwnerDeviceId) throw failure('DEVICE_AGENT_PREPARED_AUTH_REQUIRED',403);
                await options.assertDeviceAssignment(preparedAuthority.scope,agentId);await fence();
                const refreshed=await options.authorizePrepared?.(request,agentId,input);await fence();
                if(!refreshed || hash(refreshed)!==hash(preparedAuthority))throw failure('DEVICE_AGENT_PREPARED_AUTH_CHANGED',403);
                if(action === 'preparedEnqueue') {
                  await enqueuePrepared(preparedAuthority.scope,agentId,input.delivery,fenceSync,preparedAuthority.ledgerOwnerDeviceId,markWrite);await fence();
                  await waitReceipt(preparedAuthority.scope,agentId,input.delivery.deliveryId,DEVICE_AGENT_LIMITS.waitMs,signal);await fence();
                }
                const receipt=readPreparedReceipt(preparedAuthority.scope,agentId,input.delivery);
                return completed(receipt?200:202,{receipt:receipt || null});
              }
              const scope = authority!.scope;
              await options.assertDeviceAssignment(scope,agentId);await fence();
              const stored = resource.read(scope), agent = agentIn(stored,agentId);
              const requireDevice = () => { if (!principal?.deviceOwner || principal.sourceDeviceId !== agentId) throw failure('DEVICE_AGENT_OWNER_REQUIRED',403); };
              const currentSession = () => {
                requireDevice(); const session = agent.session;
                if (!session || !live(session) || body?.sessionId !== session.sessionId || body?.ownerEpoch !== session.ownerEpoch) throw failure('DEVICE_AGENT_NOT_LOADED',409);
                return session;
              };
              if (action === 'sessionRead' || action === 'sessionPublish') {
                if (action === 'sessionRead') { return completed(200,{ownerInstanceId:options.ownerInstanceId,authorizationIncarnation:agent.session ? hash([scope,options.ownerInstanceId,agentId,agent.session.sessionId,agent.session.ownerEpoch]) : null,
                  session:agent.session ? {...agent.session,loaded:live(agent.session)} : null}); }
                requireDevice();
                const sessionId = id(body?.sessionId), name = String(body?.name || '').trim();
                if (!name || name.length > DEVICE_AGENT_LIMITS.sessionName || typeof body.loaded !== 'boolean' || !Array.isArray(body.capabilities) || body.capabilities.some((value: unknown) => typeof value !== 'string' || value.length > DEVICE_AGENT_LIMITS.capabilityText)) throw failure('DEVICE_AGENT_SESSION_INVALID');
                if (live(agent.session) && (sessionId !== agent.session!.sessionId || body.ownerEpoch !== agent.session!.ownerEpoch)) throw failure('DEVICE_AGENT_OWNER_ALREADY_LOADED',409);
                const same = agent.session?.sessionId === sessionId && agent.session.managerEpoch === managerEpoch && body.ownerEpoch === agent.session.ownerEpoch;
                if (!same) for (const row of agent.deliveries) if (row.status === 'claimed' || (row.prepared && row.status==='queued')) row.status = 'result-unknown';
                agent.session = {sessionId,name,ownerEpoch:same ? agent.session!.ownerEpoch : randomUUID(),managerEpoch,loaded:body.loaded,expiresAt:now()+DEVICE_AGENT_LIMITS.leaseMs,capabilities:[...new Set(body.capabilities as string[])].slice(0,DEVICE_AGENT_LIMITS.capabilities)};
                commit(scope,stored); return completed(200,{session:agent.session});
              }
              if(action === 'pending') {
                if(!agent.deliveries.some(row=>row.status==='queued')) await waitChange(scope,Number(selectors.waitMs || 0),signal);
                const fresh=options.authorize(request);
                if(!fresh || fresh.scope!==scope || fresh.sourceDeviceId!==principal?.sourceDeviceId)throw failure('DEVICE_AGENT_CONNECTION_CHANGED',401);
                const latest=readableAgent(resource.read(scope),agentId);
                return completed(200,{pending:latest?.deliveries.some(row=>row.status==='queued') || false});
              }
              if (action === 'deliveryEnqueue') {
                const envelope = body?.envelope as RabiDeliveryEnvelope, deliveryId = id(body?.deliveryId);
                if (!envelope || envelope.deliveryId !== deliveryId) throw failure('DEVICE_AGENT_ENVELOPE_INVALID');
                const result=await enqueue(scope,agentId,envelope,async()=>{const fresh=await options.authorizeDelivery(request,agentId);if(!fresh || hash(fresh)!==hash(authority))throw failure('DEVICE_AGENT_ROUTE_AUTH_CHANGED',403);await fence();},markWrite);
                return completed(result.ownerAccepted?200:202,{receipt:result});
              }
              if (action === 'wakeList' || action === 'wakeClaim' || action === 'wakeReceipt') {
                if (action === 'wakeList') {
                  const pending=(selected:Agent|undefined)=>selected?.deliveries.filter(row => row.status === 'queued' && row.wake.status === 'pending' && !live(selected.session)).map(row=>({agentId,nonce:row.wake.nonce,deliveryId:row.deliveryId})) || [];
                  if(!pending(agent).length)await waitChange(scope,Number(selectors.waitMs || 0),signal);
                  const fresh=options.authorize(request);if(!fresh || fresh.scope!==scope || fresh.sourceDeviceId!==principal?.sourceDeviceId)throw failure('DEVICE_AGENT_CONNECTION_CHANGED',401);
                  return completed(200,{requests:pending(readableAgent(resource.read(scope),agentId))});
                }
                const row = agent.deliveries.find(row => row.wake.nonce === selectors.nonce);
                if (!row) throw failure('DEVICE_AGENT_WAKE_NOT_FOUND',404);
                if (action === 'wakeClaim') {
                  if (row.wake.status !== 'pending') throw failure('DEVICE_AGENT_WAKE_ALREADY_CLAIMED',409);
                  row.wake.status='claimed'; row.wake.claimToken=randomUUID(); commit(scope,stored); return completed(200,{nonce:row.wake.nonce,claimToken:row.wake.claimToken});
                }
                if (action === 'wakeReceipt') {
                  if (body?.claimToken !== row.wake.claimToken || !['submitted','failed'].includes(body?.status)) throw failure('DEVICE_AGENT_WAKE_RECEIPT_INVALID',409);
                  if (row.wake.status !== 'claimed' && row.wake.status !== body.status) throw failure('DEVICE_AGENT_WAKE_RECEIPT_CONFLICT',409);
                  row.wake.status=body.status; row.wake.errorCode=String(body.errorCode || '').slice(0,DEVICE_AGENT_LIMITS.errorCode); commit(scope,stored); return completed(200,{receipt:receipt(row)});
                }
              }
              if (action === 'deliveryClaim') {
                const session=currentSession();
                // One live owner cannot start another Route turn before settling the first.
                const active=agent.deliveries.find(row=>row.status==='claimed' && row.ownerEpoch===session.ownerEpoch);
                if (active) { return completed(200,{delivery:null,activeReceipt:receipt(active)}); }
                let claimStore=stored,claimAgent=agent;
                let row=agent.deliveries.find(row=>row.status==='queued');
                if(!row) { return completed(200,{delivery:null}); }
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
                  if(newlyActive){return completed(200,{delivery:null,activeReceipt:receipt(newlyActive)});}
                  row=claimAgent.deliveries.find(row=>row.deliveryId===originalId);
                  if(!row || row.status!=='queued' || row.fingerprint!==originalFingerprint)throw failure('DEVICE_AGENT_DELIVERY_CHANGED',409);
                  if(ledgerCancelled) {
                    row.status='result-unknown';row.response={status:'result-unknown',text:'',errorCode:'ledger_cancelled'};commit(scope,claimStore);
                    return completed(200,{delivery:null,cancelledReceipt:receipt(row)});
                  }
                }
                row.status='claimed'; row.sessionId=session.sessionId; row.ownerEpoch=session.ownerEpoch; row.claimToken=randomUUID(); commit(scope,claimStore);
                return completed(200,{delivery:{deliveryId:row.deliveryId,prompt:row.prompt,envelope:row.envelope,sessionId:row.sessionId,ownerEpoch:row.ownerEpoch,claimToken:row.claimToken,
                  ...(row.prepared?.ledgerOwnerDeviceId ? {ledgerOwnerDeviceId:row.prepared.ledgerOwnerDeviceId} : {})}});
              }
              if (action === 'deliveryRead' || action === 'deliveryResponse') {
                const row=agent.deliveries.find(row=>row.deliveryId===selectors.deliveryId);
                if(!row) throw failure('DEVICE_AGENT_DELIVERY_NOT_FOUND',404);
                if (action === 'deliveryRead') {
                  const result=await waitReceipt(scope,agentId,row.deliveryId,Number(selectors.waitMs || 0),signal);
                  if(managedReceipt) {const fresh=await options.authorizeDelivery(request,agentId);if(!fresh || hash(fresh)!==hash(authority))throw failure('DEVICE_AGENT_ROUTE_AUTH_CHANGED',403);}
                  else {const fresh=options.authorize(request);if(!fresh || fresh.scope!==scope || fresh.sourceDeviceId!==principal?.sourceDeviceId)throw failure('DEVICE_AGENT_CONNECTION_CHANGED',401);}
                  return completed(200,{receipt:result});
                }
                if (action === 'deliveryResponse') {
                  currentSession();
                  if(row.sessionId!==body.sessionId || row.ownerEpoch!==body.ownerEpoch || row.claimToken!==body.claimToken) throw failure('DEVICE_AGENT_CLAIM_MISMATCH',409);
                  if(!['completed','failed','result-unknown'].includes(body.status) || typeof body.text!=='string' || body.text.length>DEVICE_AGENT_LIMITS.response) throw failure('DEVICE_AGENT_RESPONSE_INVALID');
                  const result={status:body.status,text:body.text,...(body.errorCode ? {errorCode:String(body.errorCode).slice(0,DEVICE_AGENT_LIMITS.errorCode)} : {})};
                  if(row.response && hash(row.response)!==hash(result)) throw failure('DEVICE_AGENT_RESPONSE_CONFLICT',409);
                  row.response=result; row.status=body.status; commit(scope,stored); return completed(200,{receipt:receipt(row)});
                }
              }
              throw failure('DEVICE_AGENT_ACTION_INVALID',404);
            };
            const value = await execute(); await fence(); return value;
          } catch (cause) { if(writeAttempted && cause && typeof cause==='object')Object.assign(cause,{uncertain:true});throw cause; }
        }
      });
    }
  };
}
export type DeviceAgentOwner = ReturnType<typeof createDeviceAgentOwner>;
