import test from 'node:test';import assert from 'node:assert/strict';
import {handleAgentThreadRequest,readAgentEndpointSummary} from '../agentThreads.js';
import {installAgentAdapterManifestReader} from '../shared/agentAdapterCapabilities.js';
import { ownAgentAdapter } from '@rabiroute/plugin-sdk';
import { GenerationRuntime } from '../plugin-kernel/generationRuntime.js';
import type { PluginCandidate, PluginModule } from '../plugin-kernel/types.js';
import { resolvePublishedAgentManagerProviders } from './agentManagerProviders.js';
test('a published native thread owner handles its own list/read while retirement never falls back to Codex',async()=>{
 let enabled=true;const requests:unknown[]=[];
 const remove=installAgentAdapterManifestReader(()=>enabled?[{type:'owned-fixture',label:'Owned',maturity:'experimental',transport:{protocol:'in-process',mode:'owned-session'},capabilities:{nativeThreadOperations:true,managedTasks:{agentThreads:true}}}]:[]);
 const options={allowedWorkspaces:[],invokeAgentOperation:async <T>(type:string,operation:string,payload:unknown)=>{
   assert.equal(type,'owned-fixture');assert.equal(operation,'threads.request');requests.push(payload);const request=(payload as {request:{action:string;threadId?:string}}).request;
   return {statusCode:200,data:request.action==='list'?{threads:[{id:'session',title:'Owned',cwd:process.cwd()}]}:{thread:{id:'session',title:'Owned',cwd:process.cwd()}}} as T;
 }};
 try{const list=await handleAgentThreadRequest({action:'list',agentAdapter:'owned-fixture'},options);assert.equal(list.statusCode,200);
  const read=await readAgentEndpointSummary('owned-fixture','session',options);assert.equal(read.id,'session');assert.equal(requests.length,2);
  enabled=false;await assert.rejects(handleAgentThreadRequest({action:'read',threadId:'session',agentAdapter:'owned-fixture'},options));assert.equal(requests.length,2);
 }finally{remove()}
});

test('the public session API keeps old work and unrelated providers live during a package replacement and rollback', { timeout: 5000 }, async () => {
  const modules = new WeakMap<PluginCandidate, PluginModule>();
  let notifyPublished = () => {};
  const kernel = new GenerationRuntime({
    host: 'manager', executor: { async prepare(candidate) { return modules.get(candidate)!; } },
    onPublished: () => notifyPublished()
  });
  const initialized: string[] = [];
  let replacementStarted!: () => void;
  const replacementReady = new Promise<void>(resolve => { replacementStarted = resolve; });
  function candidate(type: string, version: string, beforeObservation?: () => Promise<void>): PluginCandidate {
    const capability = `agent.adapter.${type}@1`;
    const item: PluginCandidate = {
      instanceId: `agent:${type}`, config: {}, revision: version,
      entry: { execution: 'in_process', path: 'manager.mjs' },
      manifest: { schemaVersion: 2, id: `io.fixture.${type}`, version,
        entries: { manager: { execution: 'in_process', module: './manager.mjs' } },
        provides: [capability], requires: [], optional: [], permissions: [] }
    };
    modules.set(item, { activate(context) {
      const thread = { id: 'native-session', title: version, cwd: process.cwd() };
      ownAgentAdapter(context, { type, capability, manifest: {
        type, label: type, maturity: 'experimental', transport: { protocol: 'fixture', mode: 'native' },
        capabilities: { managedTasks: { agentThreads: true }, sessionOperations: { observeDelivery: true, create: 'with-initial-message' } }
      }, initialization: { mode: 'independent', start: (signal) => {
        signal.throwIfAborted();
        if (version === '2.0.0') throw new Error('fixture initialization failed');
        initialized.push(`${type}:${version}`);
        if (type === 'external' && version === '1.1.0') setImmediate(replacementStarted);
      } }, operations: {
        'threads.list': () => [thread],
        'threads.read': () => thread,
        'threads.create': ({ intentId, workspace }) => ({ state: 'created', intentId, thread: { ...thread, cwd: workspace } }),
        'threads.observeDelivery': async ({ deliveryId }) => {
          await beforeObservation?.();
          return { history: [], delivery: { deliveryId, source: version, state: 'accepted', retryable: false } };
        }
      } });
    } });
    return item;
  }

  let entered!: () => void;
  const observationEntered = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void;
  const observationMayFinish = new Promise<void>(resolve => { resume = resolve; });
  const original = candidate('external', '1.0.0', async () => { entered(); await observationMayFinish; });
  const peer = candidate('peer', '1.0.0');
  const replacement = candidate('external', '1.1.0');
  const options = { allowedWorkspaces: [], getProviders: () => resolvePublishedAgentManagerProviders(kernel.current()) };
  const originalRequest = { action: 'read', agentAdapter: 'external', threadId: 'native-session', deliveryId: 'original-delivery' } as const;
  try {
    await kernel.switch([original, peer]);
    const originalRead = handleAgentThreadRequest(originalRequest, options);
    await observationEntered;
    const published = new Promise<void>(resolve => { notifyPublished = resolve; });
    const switching = kernel.switch([replacement, peer]);
    await published;
    const unrelated = await handleAgentThreadRequest({ action: 'list', agentAdapter: 'peer' }, options);
    assert.equal(unrelated.statusCode, 200);
    assert.equal((unrelated.data.threads as Array<{ title: string }>)[0]?.title, '1.0.0');
    await replacementReady;
    const overlapping = await handleAgentThreadRequest(originalRequest, options);
    assert.equal((overlapping.data.thread as { title: string }).title, '1.1.0');
    assert.deepEqual(initialized, ['external:1.0.0', 'peer:1.0.0', 'external:1.1.0']);
    resume();
    const observed = await originalRead;
    assert.equal((observed.data.thread as { title: string }).title, '1.0.0');
    assert.equal((observed.data.delivery as { source: string }).source, '1.0.0');
    await switching;
    const updated = await handleAgentThreadRequest(originalRequest, options);
    assert.equal((updated.data.thread as { title: string }).title, '1.1.0');
    let admissionChecks = 0;
    const created = await handleAgentThreadRequest({ action: 'create', agentAdapter: 'external', title: 'New', cwd: process.cwd(),
      deliveryId: 'new-intent', prompt: 'First message' }, { ...options, assertNewAgentTask: () => { admissionChecks++; } });
    assert.equal(created.statusCode, 201);
    assert.equal(admissionChecks, 1);
    assert.equal(created.data.intentId, 'new-intent');
    await assert.rejects(handleAgentThreadRequest({ action: 'resolve', agentAdapter: 'external', title: 'Unknown' }, options), /complete external task ID/);
    await kernel.switch([original, peer]);
    const rolledBack = await handleAgentThreadRequest(originalRequest, options);
    assert.equal((rolledBack.data.thread as { title: string }).title, '1.0.0');
    await kernel.switch([candidate('external', '2.0.0'), peer]);
    assert.equal(kernel.current().records.find(record => record.identity.instanceId === 'agent:external')?.status, 'failed');
    assert.equal((await handleAgentThreadRequest({ action: 'list', agentAdapter: 'peer' }, options)).statusCode, 200);
    await kernel.switch([peer]);
    await assert.rejects(handleAgentThreadRequest(originalRequest, options), /not supported/);
  } finally {
    resume();
    await kernel.shutdown();
  }
});
