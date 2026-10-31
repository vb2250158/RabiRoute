import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Socket } from 'node:net';
import { createPersonaPlanOperations, type PersonaPlanOperationsContext } from './personaPlanOperations.js';
import { createPlanAdvanceOwner } from './planAdvanceRoutes.js';
import { createPlanAgentStatusOwner } from './planAgentStatusRoutes.js';
import { createPlanAttachmentOwner } from './planAttachmentRoutes.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { ensurePersonaPlanWorkflow } from '../personaPlanWorkflow.js';
import { createPlan, getPlan, listPlans } from '../roleKnowledge.js';
import { planWorkspaceIdentity } from '../planWorkspaceQuery.js';
import { emptyAdvancePolicy, PlanAdvanceStore } from './planAdvancePolicy.js';
import { LanAgentAuthority } from './lanAgentAuthority.js';
import { evaluateLanAgentRequest } from './lanAgentRequestAccess.js';
import { markAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from './lanAgentBodyAuthority.js';
import type { AgentThreadRequest } from '../agentThreads.js';

async function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-plan-contract-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('persona-plan-contract-'));fs.rmSync(directory,{recursive:true,force:true}); });
  const root = { current: directory }, identity = { applicationGenerationId:'original-generation',managerInstanceId:'original-manager' };
  const workflow = ensurePersonaPlanWorkflow(directory);
  const sent: AgentThreadRequest[] = [], opened: unknown[] = [];
  const outcome = { status: 'delivered' };
  const plan = createPlan(directory, {id:'plan-example',title:'Original plan',focus:'Original scope',status:workflow.workflow.roles.execution,currentStepId:'step-original',steps:[{id:'step-original',title:'Original step'}],keywords:['example'],
    taskBinding:{agentType:'dsh',sessionId:'full-session-id-original',sessionTitle:'Original session title',workspace:directory,completionHook:{enabled:false}},
    attachments:[{name:'example.txt',mimeType:'text/plain',contentBase64:Buffer.from('0123456789').toString('base64')}]
  });
  const context: PersonaPlanOperationsContext = {
    roleDir: () => root.current, identity: () => identity,
    getPlan: (dir: string, id: string) => getPlan(dir,id),
    getPlanAsync: async (dir: string, id: string) => getPlan(dir,id),
    listPlans: () => [getPlan(directory,plan.id)!], listFeedback: async () => [],
    worker: { run: async () => workflow, queryRolePlanPage: async () => ({items:[{id:plan.id}],total:1,nextCursor:''}) } as unknown as PersonaPlanOperationsContext['worker'],
    service: {
      inspectPlans: async plans => plans.map(item => ({planId:item.id,checkedAt:'2026-01-01',taskAgent:{role:'task',configured:true,agentType:'dsh',threadId:item.taskBinding!.sessionId,threadTitle:item.taskBinding!.sessionTitle!,workspace:directory,working:false,agentStatus:'idle',sessionStatus:'idle',canOpen:true,checkedAt:'2026-01-01'}})),
      openPlanAgent: async (item,role) => {opened.push(item.taskBinding);return {planId:item.id,role,agentType:'dsh',threadId:item.taskBinding!.sessionId,threadTitle:item.taskBinding!.sessionTitle!,workspace:directory,opened:true};},
      openHistoryActor: async record => {opened.push(record.actor);return {opened:true,agentType:'dsh',threadId:record.actor!.sessionId!,threadTitle:'Original history title',workspace:directory};}
    },
    send: async request => {sent.push(request);return {statusCode:200,data:{ok:true,status:outcome.status}};}
  };
  // Status reads are synchronous native selectors; advancement uses its async selector.
  const statusContext = { ...context, getPlan: (dir: string,id: string) => getPlan(dir,id) };
  const definitions = createPersonaPlanOperations({ ...context, getPlan: statusContext.getPlan });
  const authority = new LanAgentAuthority({statePath:path.join(directory,'authority.json')});
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket,'empty-node');
  const registry = new ManagerPluginRouteRegistry(), registration = registry.registerOperations('fixture-plan',definitions);
  const server = http.createServer((request,response) => {
    if (evaluateLanAgentRequest(request,authority,true).kind !== 'agent') {response.writeHead(403).end('{}');return;}
    markAuthenticatedConnectionRequest(request);
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!,'http://fixture.invalid').pathname,body,undefined));
    if (!registry.handle(request,new URL(request.url!,'http://fixture.invalid'),response)) response.writeHead(404).end('{}');
  });
  t.after(async()=>{server.closeAllConnections();await registration.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const call=(suffix:string,method='GET',body?:unknown,headers:Record<string,string>={})=>new Promise<{status:number;headers:http.IncomingHttpHeaders;bytes:Buffer;json():any}>((resolve,reject)=>{
    const request=http.request(base+'/api/roles/Example/'+suffix,{method,headers:{authorization:'Bearer '+credential.token,'content-type':'application/json',...headers}},response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);response.on('end',()=>{const bytes=Buffer.concat(chunks);resolve({status:response.statusCode!,headers:response.headers,bytes,json:()=>JSON.parse(bytes.toString())});});});request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));
  });
  return {directory,root,identity,workflow,plan,context:statusContext,definitions,call,sent,opened,outcome};
}

async function enable(f: Awaited<ReturnType<typeof fixture>>) {
  const initial=await f.call('plan-advance/settings?workspace='+encodeURIComponent(f.directory));assert.equal(initial.status,200);
  const policy={...emptyAdvancePolicy(),enabled:true,rules:{[f.plan.status]:{enabled:true,prompt:'Inspect original evidence',action:'inspect',condition:'changed',cooldownMinutes:1,maxRunsPerStep:2}}};
  const body={workspace:f.directory,revision:initial.json().data.revision,policy};
  assert.equal((await f.call('plan-advance/settings','PUT',body)).status,200);
  assert.equal((await f.call('plan-advance/settings','PUT',body)).status,400);
}
const inventory=(f:Awaited<ReturnType<typeof fixture>>)=>({workspace:f.directory,sessionIds:['full-session-id-original'],planIds:[f.plan.id]});

test('eight exact definitions allow an authenticated empty node to inspect and open the original full session identity',async t=>{
  const f=await fixture(t);assert.equal(f.definitions.length,8);
  const response=await f.call('plan-agents/status?planId='+f.plan.id+'&planId=missing');assert.equal(response.status,200,response.bytes.toString());assert.deepEqual(response.json().data.missingPlanIds,['missing']);assert.equal(response.json().data.items[0].taskAgent.threadTitle,'Original session title');
  const opened=await f.call('plan-agents/'+f.plan.id+'/open','POST',{role:'task',actor:{sessionId:'forged'}});assert.equal(opened.status,202);assert.equal(opened.json().data.threadId,'full-session-id-original');assert.equal(f.opened.length,1);
  assert.equal(f.sent.length,0);
});

test('native workspace CAS and checked advancement fingerprints persist one original-session delivery and block repeat dispatch',async t=>{
  const f=await fixture(t);await enable(f);
  const check=await f.call('plan-advance/check','POST',inventory(f));assert.equal(check.status,200);assert.equal(check.json().data.items[0].eligible,true);
  const expected={[f.plan.id]:check.json().data.items[0].fingerprint};
  const run=await f.call('plan-advance/run','POST',{...inventory(f),expected});assert.equal(run.status,200);assert.equal(run.json().data.items[0].state,'accepted');
  assert.equal(f.sent[0].threadId,'full-session-id-original');assert.equal(f.sent[0].cwd,planWorkspaceIdentity(f.directory));assert.equal(f.sent[0].createIfMissing,false);assert.match(f.sent[0].prompt!,/plan-example/);
  const repeat=await f.call('plan-advance/run','POST',{...inventory(f),expected});assert.equal(repeat.json().data.items[0].reason,'already_consumed');assert.equal(f.sent.length,1);
  const store=new PlanAdvanceStore(f.directory);assert.equal(store.read().receipts[store.receiptKey(f.directory,f.plan.id)].state,'accepted');
});

test('unconfirmed native delivery retains its original uncertain receipt and is not dispatched again',async t=>{
  const f=await fixture(t);await enable(f);f.outcome.status='queued';
  const check=await f.call('plan-advance/check','POST',inventory(f));const expected={[f.plan.id]:check.json().data.items[0].fingerprint};
  const run=await f.call('plan-advance/run','POST',{...inventory(f),expected});assert.equal(run.json().data.items[0].state,'uncertain');
  const repeat=await f.call('plan-advance/run','POST',{...inventory(f),expected});assert.equal(repeat.json().data.items[0].reason,'delivery_uncertain');assert.equal(f.sent.length,1);
  const store=new PlanAdvanceStore(f.directory);assert.equal(store.read().receipts[store.receiptKey(f.directory,f.plan.id)].id,f.sent[0].deliveryId);
});

test('native attachment HTTP responses preserve full bytes, HEAD metadata, suffix ranges and 416',async t=>{
  const f=await fixture(t),suffix='plans/'+f.plan.id+'/attachments/'+f.plan.attachments[0].id;
  const full=await f.call(suffix);assert.equal(full.status,200);assert.equal(full.bytes.toString(),'0123456789');assert.equal(full.headers['content-length'],'10');assert.match(String(full.headers['content-disposition']),/^attachment;/);
  const head=await f.call(suffix,'HEAD');assert.equal(head.status,200);assert.equal(head.bytes.length,0);assert.equal(head.headers['content-length'],'10');
  const range=await f.call(suffix,'GET',undefined,{range:'bytes=-3'});assert.equal(range.status,206);assert.equal(range.bytes.toString(),'789');assert.equal(range.headers['content-range'],'bytes 7-9/10');
  const invalid=await f.call(suffix,'GET',undefined,{range:'bytes=99-100'});assert.equal(invalid.status,416);assert.equal(invalid.headers['content-range'],'bytes */10');assert.equal(invalid.bytes.length,0);
});

test('prepared plan owners reject a changed persona directory before status disclosure, attachment read or policy save',async t=>{
  const f=await fixture(t),request=()=>new http.IncomingMessage(new Socket());
  const status=createPlanAgentStatusOwner(f.context).prepare(request(),'Example');
  const attachment=createPlanAttachmentOwner(f.context).prepare(request(),'Example',f.plan.id,f.plan.attachments[0].id);
  const advance=createPlanAdvanceOwner(f.context).prepare(request(),'Example');
  f.root.current=path.join(f.directory,'replacement');
  await assert.rejects(status.inspect([]),(error:any)=>error.statusCode===409);
  assert.throws(()=>attachment.read(),(error:any)=>error.statusCode===409);
  await assert.rejects(advance.execute('settings.save',{workspace:f.directory}),(error:any)=>error.statusCode===409);
  assert.equal(fs.existsSync(path.join(f.directory,'plan-advance.json')),false);
});


test('cancellation after a partial reservation restores unsent receipts and releases the original busy session', async t => {
  const f = await fixture(t); await enable(f);
  const second = { ...f.plan, id: 'plan-second' };
  let readCount = 0, release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const admitted = new Promise<void>(resolve => { started = resolve; });
  let hold = false;
  const context = { ...f.context, getPlanAsync: async (_dir: string, id: string) => {
    if (hold && ++readCount === 4) { started(); await gate; }
    return id === second.id ? second : f.plan;
  } };
  const owner = createPlanAdvanceOwner(context), request = () => new http.IncomingMessage(new Socket());
  const body = { ...inventory(f), planIds: [f.plan.id, second.id] };
  const checked = await owner.prepare(request(), 'Example').execute('check', body) as { items: Array<{planId:string;fingerprint:string}> };
  const expected = Object.fromEntries(checked.items.map(item => [item.planId,item.fingerprint]));
  hold = true; const controller = new AbortController();
  const pending = owner.prepare(request(), 'Example', controller.signal).execute('run', { ...body, expected });
  await admitted;
  const store = new PlanAdvanceStore(f.directory); assert.equal(Object.keys(store.read().receipts).length,1);
  controller.abort(new Error('Controlled cancellation')); release();
  await assert.rejects(pending, /Controlled cancellation/);
  assert.deepEqual(store.read().receipts, {}); assert.equal(f.sent.length,0);
  hold = false;
  const recovered = await owner.prepare(request(), 'Example').execute('run', { ...body, expected }) as { items: Array<{state:string}> };
  assert.equal(recovered.items.length,2);assert.ok(recovered.items.every(item => item.state === 'accepted'));assert.equal(f.sent.length,1);
});
