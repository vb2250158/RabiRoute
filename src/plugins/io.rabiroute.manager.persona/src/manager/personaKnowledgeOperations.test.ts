import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Socket } from 'node:net';
import { createPersonaKnowledgeOperations } from './personaKnowledgeOperations.js';
import { createKnowledgeSearchOwner } from './knowledgeSearchRoutes.js';
import { KnowledgeSearchService } from '../../../../manager/knowledgeSearchService.js';
import { ManagerReadWorkerPool } from '../../../../manager/managerReadWorkerPool.js';
import type { KnowledgeStorageDelta } from '../../../../manager/knowledgeSearchStorage.js';
import { ManagerPluginRouteRegistry } from '../../../../manager/managerPluginRouteRegistry.js';
import { publishRoleKnowledgeCatalogSnapshot,readRoleKnowledgeCatalogSnapshot } from '../../../../roleKnowledge.js';
import { LanAgentAuthority } from '../../../../manager/lanAgentAuthority.js';
import { evaluateLanAgentRequest } from '../../../../manager/lanAgentRequestAccess.js';
import { markAuthenticatedConnectionRequest } from '../../../../manager/connectionRequestAccess.js';
import { registerLanAgentBodyGuard } from '../../../../manager/lanAgentBodyAuthority.js';

function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
const delta=()=>({inventory:{},removed:[],errors:0,filesRead:0,changes:[{kind:'recent' as const,item:{id:'one',title:'Original title',focus:'Original focus',content:'Original body',keywords:['alpha'],createdAt:'2026-01-01',updatedAt:'2026-01-01'}}]});
async function fixture(t:test.TestContext,nativeWorker=false) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'persona-knowledge-contract-')),roleDir=path.join(directory,'Example');fs.mkdirSync(roleDir);fs.writeFileSync(path.join(roleDir,'persona.md'),'# Example');
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('persona-knowledge-contract-'));fs.rmSync(directory,{recursive:true,force:true});});
  const pool=nativeWorker?new ManagerReadWorkerPool({maxConcurrency:1,maxQueue:1,timeoutMs:5000}):undefined;
  if(pool){fs.mkdirSync(path.join(roleDir,'memory','recent'),{recursive:true});fs.writeFileSync(path.join(roleDir,'memory','recent','one.json'),JSON.stringify(delta().changes[0].item));}
  const root={current:directory},identity={applicationGenerationId:'original-generation',managerInstanceId:'original-manager'},service=new KnowledgeSearchService({watch:false,readDelta:pool?(dir,previous,signal)=>pool.run<KnowledgeStorageDelta>({type:'knowledge_search_delta',roleDir:dir,previous},{signal}):async()=>delta()});
  const services={current:service as KnowledgeSearchService|undefined},refreshes:string[]=[];
  const context={get service(){return services.current;},roleDirectory:()=>path.join(root.current,'Example'),identity:()=>identity,requestCatalogRefresh:(dir:string)=>{refreshes.push(dir);}};
  const definitions=createPersonaKnowledgeOperations(context),registry=new ManagerPluginRouteRegistry(),registration=registry.registerOperations('fixture-knowledge',definitions);
  const authority=new LanAgentAuthority({statePath:path.join(directory,'authority.json')}),credential=authority.enroll(authority.issueBootstrapTicket().ticket,'empty-node');
  const server=http.createServer((request,response)=>{if(evaluateLanAgentRequest(request,authority,true).kind!=='agent'){response.writeHead(403).end('{}');return;}markAuthenticatedConnectionRequest(request);registerLanAgentBodyGuard(request,() => {});if(!registry.handle(request,new URL(request.url!,'http://fixture.invalid'),response))response.writeHead(404).end('{}');});
  t.after(async()=>{server.closeAllConnections();await registration.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));await service.close();if(services.current&&services.current!==service)await services.current.close();await pool?.stop();});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const call=(suffix:string,method='GET',body?:unknown,prefix='/api/roles')=>new Promise<{status:number;body:any}>((resolve,reject)=>{const request=http.request(base+prefix+'/Example/'+suffix,{method,headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'}},response=>{let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('error',reject);response.on('end',()=>resolve({status:response.statusCode!,body:JSON.parse(text)}));});request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));});
  return {directory,roleDir,root,identity,service,services,context,definitions,refreshes,pool,call};
}

test('all five knowledge operations allow an authenticated empty node and retain native search/status/reload/published validation',async t=>{
  const f=await fixture(t);assert.equal(f.definitions.length,5);
  assert.equal((await f.call('knowledge/cache/reload','POST')).status,200);
  const search=await f.call('knowledge/search?query=alpha');assert.equal(search.status,200);assert.equal(search.body.data.items[0].id,'one');assert.equal(search.body.data.items[0].detailUrl,'/api/roles/Example/memory/recent/one');assert.equal('content' in search.body.data.items[0],false);
  assert.equal((await f.call('knowledge/cache/status')).body.data.ready,true);
  const cold=await f.call('knowledge-validation');assert.equal(cold.status,503);assert.equal(cold.body.error,'cache_unavailable');assert.deepEqual(f.refreshes,[f.roleDir]);
  publishRoleKnowledgeCatalogSnapshot(f.roleDir,readRoleKnowledgeCatalogSnapshot(f.roleDir));
  for(const prefix of ['/api/roles','/roles']){const validation=await f.call('knowledge-validation','GET',undefined,prefix);assert.equal(validation.status,200);assert.equal(validation.body.data.ok,true);assert.deepEqual(validation.body.data.issues,[]);}
});

test('native reload keeps point/all validation, accepts the original unlimited/unknown-field body and rejects expired cursors',async t=>{
  const f=await fixture(t);await f.service.reload('Example',f.roleDir);
  for(const body of [{kind:'recent'},{id:'one'},{all:'yes'},{all:true,kind:'recent',id:'one'}])assert.equal((await f.call('knowledge/cache/reload','POST',body)).status,400);
  assert.equal((await f.call('knowledge/cache/reload','POST',{kind:'recent',id:'one'})).status,200);
  assert.equal((await f.call('knowledge/cache/reload','POST',{originalIgnoredField:'x'.repeat(1024*1024+1)})).status,200);
  assert.equal((await f.call('knowledge/search?query=alpha&cursor=999999:1')).status,409);
  assert.equal((await f.call('knowledge/search?query=alpha&mode=invalid')).status,400);
});

test('query and reload parameter errors identify real fields and same-role summary discovery without reloading', async t => {
  const f=await fixture(t);await f.service.reload('Example',f.roleDir);
  let reloads=0;const reload=f.service.reload.bind(f.service);t.mock.method(f.service,'reload',async(...args:Parameters<typeof reload>)=>{reloads++;return reload(...args);});
  for(const [query,status,field,code] of [
    ['query=alpha&mode=invalid',400,'query.mode','KNOWLEDGE_PARAMETER_INVALID'],
    ['query=alpha&kind=invalid',400,'query.kind','KNOWLEDGE_PARAMETER_INVALID'],
    ['query=%20%20',400,'query.query','KNOWLEDGE_PARAMETER_INVALID'],
    ['query=alpha&limit=101',400,'query.limit','KNOWLEDGE_PARAMETER_INVALID'],
    ['query=alpha&cursor=invalid',400,'query.cursor','KNOWLEDGE_CURSOR_INVALID'],
    ['query=alpha&mode=fulltext&kind=recent&archived=1&limit=10&cursor=999999:0',409,'query.cursor','KNOWLEDGE_CURSOR_EXPIRED']
  ] as const){
    const response=await f.call('knowledge/search?'+query);assert.equal(response.status,status,JSON.stringify(response.body));
    assert.equal(response.body.errorCode,code);assert.equal(response.body.field,field);
    assert.match(response.body.repair,/GET \/api\/roles\/Example\/knowledge\/cache\/status/);
    assert.match(response.body.repair,/GET \/api\/roles\/Example\/knowledge\/search\?query=/);
    assert.match(response.body.repair,/operationId=manager.personas.knowledge.search/);
    if(status===409){assert.match(response.body.repair,/original role\/query\/mode\/kind\/archived\/limit/);assert.doesNotMatch(response.body.repair,/mode=keywords&limit=10/);}
    assert.doesNotMatch(JSON.stringify(response.body),/original body|private-native/);
  }
  for(const [body,field] of [[{kind:'recent'},'body.id'],[{id:'one'},'body.kind'],[{kind:'other',id:'one'},'body.kind'],[{kind:'recent',id:42},'body.id'],[{all:'yes'},'body.all'],[{all:true,kind:'recent',id:'one'},'body.all']] as const){
    const response=await f.call('knowledge/cache/reload','POST',body);assert.equal(response.status,400);
    assert.equal(response.body.field,field);assert.equal(response.body.errorCode,'KNOWLEDGE_PARAMETER_INVALID');
    assert.match(response.body.repair,/operationId=manager.personas.knowledge.cache.reload/);
  }
  assert.equal(reloads,0);
  const version=f.service.status(f.roleDir);assert.ok('version' in version);
  for(const query of ['query=alpha&limit=1e1','query=alpha&limit=0x10','query=alpha&kind=&mode=keywords&mode=invalid',`query=alpha&cursor=${version.version}:0:legacy-suffix`])assert.equal((await f.call('knowledge/search?'+query)).status,200);
  assert.equal((await f.call('knowledge/search?query=alpha&limit=')).status,400);
  const empty=await f.call('knowledge/search?query=no-match');assert.equal(empty.status,200);assert.deepEqual(empty.body.data.items,[]);
  assert.deepEqual(empty.body.data.coverage,{scope:'indexed-inventory',state:'complete',errors:0});
  for(const raw of [[],42,true,'legacy'])assert.ok([200,202].includes((await f.call('knowledge/cache/reload','POST',raw)).status));
  const missing=await f.call('knowledge/cache/reload','POST',{kind:'recent',id:'unknown-id'});assert.ok([200,202].includes(missing.status));
});

test('warming and native transport failures retain availability status and do not become parameter labels',async t=>{
  const f=await fixture(t);f.services.current=undefined;
  const warming=await f.call('knowledge/search?query=alpha&mode=invalid');assert.equal(warming.status,503);
  assert.equal(warming.body.errorCode,'KNOWLEDGE_INDEX_WARMING');assert.equal(warming.body.field,undefined);
  f.services.current=f.service;await f.service.reload('Example',f.roleDir);
  t.mock.method(f.service,'reload',async()=>{throw Object.assign(new Error('Synthetic upstream unavailable'),{statusCode:503});});
  const unavailable=await f.call('knowledge/cache/reload','POST',{});assert.equal(unavailable.status,503);
  assert.equal(unavailable.body.errorCode,undefined);assert.equal(unavailable.body.field,undefined);
});

test('one bad native row leaves healthy HTTP summaries available with explicit partial coverage and raw preservation',{timeout:15000},async t=>{
  const f=await fixture(t,true),bad=path.join(f.roleDir,'memory/recent/bad.json');fs.writeFileSync(bad,'{private-bad-row');
  const before=fs.readFileSync(bad);const refreshed=await f.call('knowledge/cache/reload','POST',{});
  assert.equal(refreshed.status,202);assert.equal(refreshed.body.data.ready,true);assert.equal(refreshed.body.data.errors,1);
  const search=await f.call('knowledge/search?query=alpha');assert.equal(search.status,200);assert.equal(search.body.data.items[0].id,'one');
  assert.deepEqual(search.body.data.coverage,{scope:'indexed-inventory',state:'partial',errors:1});assert.deepEqual(fs.readFileSync(bad),before);
  assert.doesNotMatch(JSON.stringify(search.body),/private-bad-row/);assert.equal(f.pool!.status().active,0);
});

test('late reload cannot disclose an index after its original directory or exact Manager service changes',async t=>{
  const f=await fixture(t),wait=gate(),entered=gate();t.after(wait.release);
  const reload=f.service.reload.bind(f.service);
  t.mock.method(f.service,'reload',async(...args:Parameters<typeof reload>)=>{entered.release();await wait.promise;return reload(...args);});
  const pending=f.call('knowledge/cache/reload','POST',{});await entered.promise;f.root.current=path.join(f.directory,'replacement');wait.release();
  const result=await pending;assert.equal(result.status,409);assert.equal(result.body.data,undefined);
  f.root.current=f.directory;
  const prepared=createKnowledgeSearchOwner(f.context).prepare(new http.IncomingMessage(new Socket()),'Example');
  const replacement=new KnowledgeSearchService({watch:false,readDelta:async()=>delta()});f.services.current=replacement;
  assert.throws(()=>prepared.status(),(error:any)=>error.statusCode===409);
  await replacement.close();f.services.current=undefined;
  assert.equal((await f.call('knowledge/cache/status')).status,503);
});

test('caller cancellation waits for the original reload and does not abort or replace the shared service worker',async t=>{
  const f=await fixture(t),wait=gate(),entered=gate();let nativeSignal:AbortSignal|undefined;
  const service=new KnowledgeSearchService({watch:false,readDelta:async(_directory,_inventory,signal)=>{nativeSignal=signal;entered.release();await wait.promise;return delta();}});
  t.after(async()=>{wait.release();await service.close();});
  const context={...f.context,service};const controller=new AbortController();
  const owner=createKnowledgeSearchOwner(context);
  const pending=owner.prepare(new http.IncomingMessage(new Socket()),'Example',controller.signal).reload({});
  await entered.promise;controller.abort(new Error('Controlled caller cancellation'));assert.equal(nativeSignal!.aborted,false);wait.release();
  await assert.rejects(pending,/Controlled caller cancellation/);
  assert.equal(owner.prepare(new http.IncomingMessage(new Socket()),'Example').status().ready,true);
});


test('public cache reload uses the original native delta worker and joins its actual process shutdown', {timeout:15000}, async t => {
  const f=await fixture(t,true);
  assert.equal((await f.call('knowledge/cache/reload','POST',{})).status,200);
  const response=await f.call('knowledge/search?query=alpha');assert.equal(response.status,200);assert.equal(response.body.data.items[0].id,'one');
  assert.equal(f.pool!.status().active,0);assert.equal(f.pool!.status().queued,0);assert.equal(f.pool!.status().workerPids.length,1);
  await f.service.close();await f.pool!.stop();
  assert.equal(f.pool!.status().active,0);assert.equal(f.pool!.status().queued,0);assert.deepEqual(f.pool!.status().workerPids,[]);
});
