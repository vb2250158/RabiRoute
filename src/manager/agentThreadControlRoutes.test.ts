import assert from "node:assert/strict";
import http from "node:http";
import { Socket } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRequestStoreUnavailableError, type AgentRequestStore } from "../agentRequests/store.js";
import { handleAgentThreadRequest, agentThreadRequestFailureData, type AgentThreadRequestOptions, type AgentThreadDriver } from "../agentThreads.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { createAgentThreadControlOwner, type AgentThreadControlRoutesContext } from "./agentThreadControlRoutes.js";
import { createAgentThreadControlOperations } from "./agentThreadControlOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";

function deferred<T>() { let resolve!: (value:T)=>void; const promise = new Promise<T>(done => { resolve = done; }); return {promise,resolve}; }
function request() { return new http.IncomingMessage(new Socket()); }
function context(overrides: Partial<AgentThreadControlRoutesContext> = {}): AgentThreadControlRoutesContext {
  return { agentRequests: { get: () => undefined } as unknown as AgentRequestStore,
    messageProcessingBoard: { submitOutcome: () => { throw new Error("Unexpected handoff"); }, recordHandoffReturned: () => { throw new Error("Unexpected return"); } },
    applyManagedAgentThreadDefaults: value => value,
    agentThreadRequestOptions: () => ({ allowedWorkspaces: [] }), handleAgentThreadRequest: async () => ({ statusCode:200, data:{ok:true} }),
    agentThreadRequestFailureData, setMessageProcessingPlanBaseline: () => {}, refreshAgentRequestReminderTimers: () => {}, publishManagerEvent: () => {},
    operationalLog: { record: () => null }, operationalError: () => undefined, ...overrides };
}
async function fixture(t:test.TestContext, ctx:AgentThreadControlRoutesContext, ingress?:(req:http.IncomingMessage,res:http.ServerResponse)=>boolean) {
  const owner=createAgentThreadControlOwner(ctx), registry=new ManagerPluginRouteRegistry();
  const registration=registry.registerOperations('fixture-threads',createAgentThreadControlOperations(owner));
  const server=http.createServer((req,res)=>{if(ingress && !ingress(req,res))return;if(!registry.handle(req,new URL(req.url!,'http://fixture.invalid'),res))res.writeHead(404).end('{}');});
  t.after(async()=>{server.closeAllConnections();await registration.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const call=(method:string, body?:unknown, suffix='', headers:Record<string,string>={})=>new Promise<{status:number;body:any}>((resolve,reject)=>{
    const req=http.request(base+'/api/agent/threads'+suffix,{method,headers:{'content-type':'application/json',...headers}},res=>{
      const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())});}catch(error){reject(error);}});
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  return {owner,registry,registration,base,call};
}

for (const state of ["not_started", "unknown"] as const) {
  test(`the actual thread operation retains a ${state} store failure as local 503`, async t => {
    const error = new AgentRequestStoreUnavailableError("Fixture store unavailable.", state);
    let sends = 0;
    const driver: AgentThreadDriver = { list: async () => [], read: async () => { assert.fail("Unavailable owner must not resolve another task."); },
      create: async () => { assert.fail("Unavailable owner must not create a task."); }, send: async () => { sends++; } };
    const store = { ready: async () => { throw error; } } as unknown as AgentRequestStore;
    const f = await fixture(t, context({ agentRequests: store,
      agentThreadRequestOptions: (_body, extra) => ({ allowedWorkspaces: [], ...extra }),
      handleAgentThreadRequest: (body, options) => handleAgentThreadRequest(body, options, driver) }));
    const result = await f.call("POST", { action: "send" });
    assert.equal(result.status, 503); assert.equal(result.body.error.code, error.code);
    assert.equal(result.body.error.commitState, state); assert.equal(result.body.error.retryable, false);
    assert.equal(Boolean(result.body.uncertain), state === "unknown"); assert.equal(sends, 0);
  });
}

test("an accepted thread delivery keeps its original evidence when request bookkeeping becomes unavailable", async t => {
  const error = new AgentRequestStoreUnavailableError("Fixture acknowledgement unknown.", "unknown");
  const f = await fixture(t, context({ agentRequests: { get: () => { throw error; } } as unknown as AgentRequestStore,
    handleAgentThreadRequest: async () => ({ statusCode: 202, data: { ok: false, status: "delivered_tracking_failed", threadId: "original-target",
      communication: { deliveryId: "original-delivery", requestId: "original-request", inReplyToRequestId: "original-reply" } } }),
    refreshAgentRequestReminderTimers: () => { throw error; } }));
  const result = await f.call("POST", { action: "send" });
  assert.equal(result.status, 202); assert.equal(result.body.status, "delivered_tracking_failed");
  assert.equal(result.body.threadId, "original-target"); assert.equal(result.body.communication.deliveryId, "original-delivery");
  assert.match(result.body.warning, /tracking|scheduling/);
});

test("unrelated thread listing does not refresh an unavailable request ledger", async t => {
  let refreshes = 0;
  const f = await fixture(t, context({ refreshAgentRequestReminderTimers: () => { refreshes++; throw new AgentRequestStoreUnavailableError("Fixture unavailable."); },
    handleAgentThreadRequest: async () => ({ statusCode: 200, data: { ok: true, threads: [] } }) }));
  assert.equal((await f.call("GET")).status, 200); assert.equal(refreshes, 0);
});

test('sessionless remote management remains public while source events require authenticated provenance', async t=>{
  let invoked=0;
  const f=await fixture(t,context({ handleAgentThreadRequest:async()=>{invoked++;return {statusCode:200,data:{ok:true,threads:[]}};} }),req=>{registerLanAgentBodyGuard(req,()=>{});return true;});
  assert.equal((await f.call('GET')).status,200);assert.equal(invoked,1);
  const forged=await f.call('POST',{action:'send',remoteSource:{sessionId:'forged'}});
  assert.equal(forged.status,400);assert.equal(invoked,1);
});

test('explicit unsaved source attribution retains the connector and ignores body authority fields',async()=>{
  const original={nodeId:'computer',agentId:'connector',provider:'dsh' as const,sessionId:'saved-session',sessionName:'Saved task'};
  const req=request();registerLanAgentBodyGuard(req,()=>{});let source:AgentThreadRequestOptions['remoteSource'];
  const owner=createAgentThreadControlOwner(context({getTrustedRemoteSource:()=>original,agentThreadRequestOptions:(_body,extra)=>({allowedWorkspaces:[],...extra}),
    handleAgentThreadRequest:async(_body,options)=>{source=options.remoteSource;return {statusCode:200,data:{ok:true}};}}));
  const prepared=owner.prepare(req);
  const result=await prepared.execute({action:'send',sourceThreadId:'explicit-session',messageSource:{type:'agent',agentAdapter:'dsh',sessionId:'explicit-session',sessionName:'Current task'},
    ...{remoteSource:{nodeId:'forged'},trustedDeviceSource:{sourceDeviceId:'forged'}}});
  assert.equal(result.status,200);assert.deepEqual(source,{...original,sessionId:'explicit-session',sessionName:'Current task'});assert.equal(original.sessionId,'saved-session');
});

test('caller-selected execution options freeze before Route defaults and ignore body-provided snapshots',async()=>{
  let captured:AgentThreadRequestOptions['callerExecutionOptions'];
  const owner=createAgentThreadControlOwner(context({applyManagedAgentThreadDefaults:body=>({...body,model:'route-default'}),agentThreadRequestOptions:(_body,extra)=>({allowedWorkspaces:[],...extra}),
    handleAgentThreadRequest:async(body,options)=>{assert.equal(body.model,'route-default');captured=options.callerExecutionOptions;assert.ok(Object.isFrozen(captured));return {statusCode:200,data:{ok:true}};}}));
  await owner.prepare(request()).execute({action:'send',cwd:'C:/chosen',...{callerExecutionOptions:{model:'forged'}}});assert.deepEqual(captured,{cwd:'C:/chosen'});
});

test('application connection never replaces a trusted desktop Agent source',async()=>{
  const original={nodeId:'pc',agentId:'agent',sessionId:'session',provider:'codex' as const,sessionName:'Source'};
  const req=request();registerLanAgentBodyGuard(req,()=>{});let invoked=false;
  const owner=createAgentThreadControlOwner(context({getTrustedRemoteSource:()=>original,getTrustedDeviceSource:()=>({scope:'scope',sourceDeviceId:'application',deviceOwner:false}),
    agentThreadRequestOptions:(_body,extra)=>({allowedWorkspaces:[],...extra}),handleAgentThreadRequest:async(_body,options,device)=>{invoked=true;assert.deepEqual(options.remoteSource,original);assert.equal(device,undefined);return {statusCode:200,data:{ok:true}};}}));
  assert.equal((await owner.prepare(req).execute({action:'send',sourceThreadId:'session'})).status,200);assert.ok(invoked);
});

test('HTTP native source comes only from ingress and retains the original revocation fence',async t=>{
  const verified={scope:'scope',sourceDeviceId:'glasses-a',deviceOwner:true};let current=true;const observed:unknown[]=[];
  const began=deferred<void>(),resume=deferred<void>();t.after(()=>resume.resolve());
  const f=await fixture(t,context({getTrustedDeviceSource:req=>req.headers['x-test-source']==='verified'?verified:undefined,
    agentThreadRequestOptions:(_body,extra)=>({allowedWorkspaces:[],...extra}),handleAgentThreadRequest:async(_body,options,source)=>{observed.push(source);if(observed.length===2){began.resolve();await resume.promise;}options.requestAuthority?.();return {statusCode:200,data:{ok:true}};}}),req=>{
      registerLanAgentBodyGuard(req,()=>{});markAuthenticatedConnectionRequest(req,()=>{if(!current)throw new Error('connection revoked');});return true;});
  const body={action:'send',...{trustedDeviceSource:verified,remoteSource:{sessionId:'forged'}}};
  assert.equal((await f.call('POST',body)).status,400);assert.equal(observed.length,0);
  assert.equal((await f.call('POST',body,'',{'x-test-source':'verified'})).status,200);assert.deepEqual(observed,[verified]);
  const pending=f.call('POST',body,'',{'x-test-source':'verified'});await began.promise;current=false;resume.resolve();
  const rejected=await pending;assert.equal(rejected.status,403);assert.equal(rejected.body.errorCode,'API_REQUEST_AUTHORITY_REVOKED');
});

for(const reject of [false,true])test('registration retirement joins actual native work after response close: '+(reject?'rejection':'success'),{timeout:4000},async t=>{
  const began=deferred<void>(),resume=deferred<void>();t.after(()=>resume.resolve());
  const f=await fixture(t,context({handleAgentThreadRequest:async()=>{began.resolve();await resume.promise;if(reject)throw new Error('Owner failed after close');return {statusCode:200,data:{ok:true,threads:[]}};}}));
  const req=http.request(f.base+'/api/agent/threads');req.on('error',()=>{});req.end();await began.promise;req.destroy();
  let stopped=false;const stopping=f.registration.dispose().then(()=>{stopped=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);
  resume.resolve();await stopping;assert.equal(f.registration.activeOperationCount(),0);
});

test('an authenticated empty remote node can list full names and IDs through the actual controlled driver',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'thread-contract-node-'));t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});});
  const authority=new LanAgentAuthority({statePath:path.join(directory,'authority.json')}),credential=authority.enroll(authority.issueBootstrapTicket().ticket,'node-without-sessions');
  const fullId='019f0000-0000-7000-8000-000000000001',name='Visible native task name';let lists=0;
  const driver:AgentThreadDriver={list:async params=>{lists++;const rows=params.query==='all-pages'?Array.from({length:205},(_,index)=>({id:fullId+'-'+index,title:name+' '+index,cwd:directory,updatedAt:'2026-01-01T00:00:00Z'})):[{id:fullId,title:name,cwd:directory,updatedAt:'2026-01-01T00:00:00Z'}];return rows.slice(params.offset,params.offset+params.limit);},read:async()=>{throw new Error('Unexpected read');},create:async()=>{throw new Error('No Runtime creation');},send:async()=>{throw new Error('No real prompt');}};
  const f=await fixture(t,context({handleAgentThreadRequest:(body,options)=>handleAgentThreadRequest(body,options,driver)}),(req,res)=>{
    if(evaluateLanAgentRequest(req,authority,true).kind!=='agent'){res.writeHead(403).end('{}');return false;}markAuthenticatedConnectionRequest(req);registerLanAgentBodyGuard(req,body=>assertLanAgentBodyAuthority('/api/agent/threads',body,undefined));return true;});
  const result=await f.call('GET',undefined,'?limit=invalid&offset=-2',{authorization:'Bearer '+credential.token});
  assert.equal(result.status,200);assert.equal(lists,1);assert.deepEqual(result.body.threads.map((row:any)=>[row.id,row.title]),[[fullId,name]]);assert.equal(result.body.offset,0);
  const first=await f.call('GET',undefined,'?query=all-pages&limit=200&limit=1',{authorization:'Bearer '+credential.token});
  assert.equal(first.status,200);assert.equal(first.body.threads.length,200);assert.equal(first.body.nextOffset,200);
  const last=await f.call('GET',undefined,'?query=all-pages&limit=200&offset='+first.body.nextOffset,{authorization:'Bearer '+credential.token});
  assert.equal(last.status,200);assert.equal(last.body.threads.length,5);assert.equal(last.body.nextOffset,null);
  assert.equal(new Set([...first.body.threads,...last.body.threads].map((row:any)=>row.id)).size,205);
  const nativeNulls=await f.call('POST',{action:'list',agentAdapter:null,query:null,instanceBinding:null,contextBlocks:null,lookupMode:'ignored-native-default',createIfMissing:null,sandbox:{ignoredForList:true}},'',{authorization:'Bearer '+credential.token});
  assert.equal(nativeNulls.status,200);assert.equal(nativeNulls.body.threads[0].id,fullId);
});

test('a prepared thread request cannot gain a replacement connector or generation before dispatch',async()=>{
  let current={nodeId:'original-node',agentId:'connector',provider:'codex' as const,sessionId:'saved',sessionName:'Original'},generation=1,invoked=0;
  const owner=createAgentThreadControlOwner(context({getTrustedRemoteSource:()=>current,assertCurrent:()=>{if(generation!==1)throw new Error('Original thread owner generation changed');},
    handleAgentThreadRequest:async()=>{invoked++;return {statusCode:200,data:{ok:true}};}}));
  const prepared=owner.prepare(request());current={...current,nodeId:'replacement-node'};
  const changed=await prepared.execute({action:'list'});assert.equal(changed.status,400);assert.match(String(changed.body.message),/source connection changed/);assert.equal(invoked,0);
  current={...current,nodeId:'original-node'};const original=owner.prepare(request());generation=2;
  const replaced=await original.execute({action:'list'});assert.equal(replaced.status,400);assert.match(String(replaced.body.message),/generation changed/);assert.equal(invoked,0);
});

test('source revocation after native mutation returns uncertainty before handoff tracking or reminders',async()=>{
  let current=true,invocations=0,tracking=0;
  const owner=createAgentThreadControlOwner(context({assertCurrent:()=>{if(!current)throw new Error('Original owner changed');},
    handleAgentThreadRequest:async()=>{invocations++;current=false;return {statusCode:200,data:{ok:true,status:'delivered',communication:{inReplyToRequestId:'original'}}};},
    publishManagerEvent:()=>{tracking++;},refreshAgentRequestReminderTimers:()=>{tracking++;}}));
  const result=await owner.prepare(request()).execute({action:'send'});
  assert.equal(result.status,400);assert.equal(result.body.uncertain,true);assert.equal(invocations,1);assert.equal(tracking,0);
});
