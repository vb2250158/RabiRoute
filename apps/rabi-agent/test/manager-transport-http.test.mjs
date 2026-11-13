import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import ts from 'typescript';
import {createManagerClient} from '../lib/manager-client.mjs';

// Compile the exact Root-owned ingress helper in memory; no service source copy or real Manager is started.
const helperUrl=new URL('../../../src/manager/managerTransportIdentity.ts',import.meta.url);
const source=await fs.readFile(helperUrl,'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
 .replace('../../apps/rabi-agent/lib/manager-transport-contract.mjs',new URL('../lib/manager-transport-contract.mjs',import.meta.url).href);
const {createManagerTransportIdentity}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));

test('modern client reuses actual HTTP target acknowledgement while auth/disable/changed-target stay authoritative',async t=>{
 let generation='app',instance='manager',revision='one',enabled=true,auth=0,metadata=0,business=0,writes=0;
 const ingress=createManagerTransportIdentity(()=>({applicationGenerationId:generation,managerInstanceId:instance,metadataRevision:revision}));
 const server=http.createServer((request,response)=>{
  const context=ingress.capture(response);auth++;
  if(request.headers.authorization!=='Bearer fixture-only'){response.writeHead(401).end();return;}
  if(ingress.rejectChanged(request,response,context))return;
  if(request.url==='/meta'){metadata++;response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({code:0,data:{applicationGenerationId:generation,managerInstanceId:instance,health:{live:true,state:'healthy',requiredReady:true},apiTransport:ingress.protocolInfo()}}));return;}
  business++;if(!enabled){response.writeHead(403,{'content-type':'application/json'}).end(JSON.stringify({code:-1,field:'enabled'}));return;}
  if(request.method==='POST')writes++;
  // A native/proxy business handler cannot overwrite the ingress-owned response identity.
  response.writeHead(200,{'content-type':'application/json','x-rabiroute-manager-context':'forged'});response.end('{"code":0,"data":{"ok":true}}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const managerUrl='http://127.0.0.1:'+server.address().port;
 const client=createManagerClient({managerUrl,credential:'fixture-only'});
 for(let index=0;index<10;index++)assert.equal((await client.request('GET','/api/fixture',{replaySafe:false})).ok,true);
 assert.equal(metadata,1);assert.equal(business,10);assert.equal(auth,11);
 enabled=false;revision='two';assert.equal((await client.request('GET','/api/fixture',{replaySafe:false})).statusCode,403);
 enabled=true;assert.equal((await client.request('GET','/api/fixture',{replaySafe:false})).ok,true);
 generation='new-app';instance='new-manager';const before=writes;
 const wrong=await client.request('POST','/api/fixture',{body:{requestId:'original-once'},headers:{'idempotency-key':'original-once'}});
 assert.equal(wrong.statusCode,409);assert.equal(wrong.executionState,'not_started');assert.equal(wrong.uncertain,false);assert.equal(writes,before);
 const recovered=await client.request('GET','/api/fixture',{replaySafe:false});assert.equal(recovered.ok,true);assert.equal(recovered.identity.managerInstanceId,'new-manager');
});
