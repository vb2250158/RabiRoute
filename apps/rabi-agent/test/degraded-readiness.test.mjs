import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const {businessReady}=await import(pathToFileURL(path.join(root,'lib/endpoint-session.mjs')));
const {createManagerClient}=await import(pathToFileURL(path.join(root,'lib/manager-client.mjs')));
const {requestHook}=await import(pathToFileURL(path.resolve(root,'../../plugins/rabi-dsh-context/manager-client.mjs')));
const health={live:true,state:'degraded',requiredReady:false};
const identity={applicationGenerationId:'fixture-generation',managerInstanceId:'fixture-manager'};
const metadata={...identity,health};
const settings={managerUrl:'http://fixture.invalid:1234',credential:'private-fixture-only',agentType:'codex',sessionId:'fixture-session'};
test('live healthy and degraded endpoint remain usable with unrelated required false',()=>{
 for(const state of ['healthy','degraded'])assert.equal(businessReady({health:{...health,state}}),true);
 for(const value of [undefined,{health:{...health,live:false}},{health:{...health,state:'failed'}},{health:{...health,state:'starting'}}])assert.equal(businessReady(value),false);
});
test('actual read retains credential and metadata identity with unrelated required false',async()=>{
 const calls=[];const client=createManagerClient({...settings,fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return Response.json(String(url).endsWith('/meta')?metadata:{code:0,data:{fixture:true}});}});
 const result=await client.invoke('GET','/api/example');assert.equal(result.ok,true);assert.equal(calls.filter(c=>c.url.endsWith('/api/example')).length,1);assert.equal(calls[1].options.headers.authorization,'Bearer '+settings.credential);
});
test('actual bounded skill download preserves bytes and postflight identity when unrelated required false',async t=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'agent-degraded-download-'));t.after(()=>fs.rm(temporary,{recursive:true,force:true}));
 const zip=Buffer.from('504b0304','hex'),hash=createHash('sha256').update(zip).digest('hex');let downloads=0;
 const client=createManagerClient({...settings,fetchImpl:async(url)=>{if(String(url).endsWith('/meta'))return Response.json(metadata);downloads++;return new Response(zip,{headers:{'content-type':'application/zip','content-length':String(zip.length),'x-rabiroute-content-sha256':hash}});}});
 const result=await client.download('/api/roles/fixture/skills/fixture/download',path.join(temporary,'fixture.zip'));assert.equal(result.ok,true);assert.equal(downloads,1);assert.deepEqual(await fs.readFile(result.path),zip);assert.deepEqual(result.identity,identity);
});
test('nonlive metadata still blocks actual download without creating output',async t=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'agent-nonlive-download-'));t.after(()=>fs.rm(temporary,{recursive:true,force:true}));let businessCalls=0;
 const client=createManagerClient({...settings,fetchImpl:async(url)=>{if(!String(url).endsWith('/meta'))businessCalls++;return Response.json({...metadata,health:{...health,live:false}});}});
 await assert.rejects(client.download('/api/roles/fixture/skills/fixture/download',path.join(temporary,'fixture.zip')));assert.equal(businessCalls,0);assert.deepEqual(await fs.readdir(temporary),[]);
});
test('DSH sends original one request after live degraded metadata without required global gate',async()=>{
 const calls=[];const input={eventName:'UserPromptSubmit',sessionId:'original-fixture-session'};
 const result=await requestHook(input,{env:{RABI_MANAGER_URL:settings.managerUrl},fetch:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/meta')?metadata:{code:0,data:{additionalContext:'fixture'}});}});
 assert.equal(result.additionalContext,'fixture');assert.equal(calls.length,2);assert.deepEqual(JSON.parse(calls[1].options.body),input);
});
test('DSH rejects nonlive or unknown state before sending body',async()=>{
 for(const bad of [{...health,live:false},{...health,state:'failed'}]){let posts=0;await assert.rejects(requestHook({},{env:{RABI_MANAGER_URL:settings.managerUrl},fetch:async(url)=>{if(!url.endsWith('/meta'))posts++;return Response.json({...metadata,health:bad});}}));assert.equal(posts,0);}
});
test('DSH retains Host generation mismatch rejection',async()=>{
 let posts=0;await assert.rejects(requestHook({},{env:{RABIROUTE_HOST_EXE:'fixture-host'},execute:async()=>({stdout:JSON.stringify({managerBaseUrl:settings.managerUrl,...identity,managerInstanceId:'different'})}),fetch:async(url)=>{if(!url.endsWith('/meta'))posts++;return Response.json(metadata);}}));assert.equal(posts,0);
});
test('same original mutation remains uncertain after identity change and is never replayed',async()=>{
 let metas=0,posts=0;const client=createManagerClient({...settings,fetchImpl:async(url)=>{if(String(url).endsWith('/meta'))return Response.json({...metadata,managerInstanceId:++metas===1?identity.managerInstanceId:'changed-fixture'});posts++;return Response.json({code:0,data:{deliveryId:'original-fixture-id'}},{headers:{'idempotency-key':'original-fixture-id'}});}});
 const result=await client.invoke('POST','/api/example',{body:{deliveryId:'original-fixture-id'},headers:{'idempotency-key':'original-fixture-id'}});assert.equal(result.uncertain,true);assert.equal(posts,1);assert.equal(result.headers['idempotency-key'],'original-fixture-id');
});
