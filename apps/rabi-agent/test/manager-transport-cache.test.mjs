import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createManagerClient } from '../lib/manager-client.mjs';
import { runCli } from '../rabi-cli.mjs';
import { createHostEndpointSession } from '../lib/host-endpoint.mjs';
import { createEndpointSession } from '../lib/endpoint-session.mjs';
import { createManagerEndpointCache } from '../lib/manager-endpoint-cache.mjs';
import { MANAGER_CONTEXT_HEADER, EXPECTED_MANAGER_GENERATION_HEADER, EXPECTED_MANAGER_INSTANCE_HEADER } from '../lib/manager-transport-contract.mjs';

const base='http://127.0.0.1:1234';
function gate(){let release;const promise=new Promise(resolve=>{release=resolve});return{promise,release};}
function fixture({modern=true}={}) {
 const state={generation:'generation',instance:'instance',revision:'r1',metadataStatus:200,businessStatus:200,metaGate:undefined,dropHeader:false};
 const counts={status:0,public:0,self:0,meta:0,business:0,writes:0,notStarted:0};
 const context=()=>({abi:1,applicationGenerationId:state.generation,managerInstanceId:state.instance,metadataRevision:state.revision});
 const metadata=()=>({rabiGuid:'stable-manager',applicationGenerationId:state.generation,managerInstanceId:state.instance,health:{live:true,state:'degraded',requiredReady:false},agentUploads:{maxFileMiB:1},...(modern?{apiTransport:{abi:1,metadataRevision:state.revision}}:{})});
 const reply=(body,status=200,ctx=context())=>Response.json(body,{status,headers:modern&&!state.dropHeader?{[MANAGER_CONTEXT_HEADER]:JSON.stringify(ctx)}:{}});
 const fetchImpl=async(url,options={})=>{
  const pathname=new URL(url).pathname;
  if (modern && (options.headers?.[EXPECTED_MANAGER_GENERATION_HEADER] && options.headers[EXPECTED_MANAGER_GENERATION_HEADER]!==state.generation || options.headers?.[EXPECTED_MANAGER_INSTANCE_HEADER] && options.headers[EXPECTED_MANAGER_INSTANCE_HEADER]!==state.instance)) {counts.notStarted++;return reply({code:-1,errorCode:'MANAGER_IDENTITY_CHANGED',executionState:'not_started'},409);}
  if(pathname==='/.well-known/rabiroute-manager'){counts.public++;return reply({code:0,data:{protocolVersion:1,guid:'stable-manager',applicationGenerationId:state.generation,managerInstanceId:state.instance}});}
  if(pathname==='/api/lan-agent/self'){counts.self++;assert.equal(options.headers.authorization,'Bearer fixture-only');return reply({code:0,data:{guid:'stable-manager',nodeId:'node',applicationGenerationId:state.generation,managerInstanceId:state.instance}});}
  if(pathname==='/meta'){counts.meta++;const body=metadata(),ctx=context(),status=state.metadataStatus;if(state.metaGate)await state.metaGate.promise;return reply(status===200?{code:0,data:body}:{code:-1,message:'metadata temporarily unavailable'},status,ctx);}
  counts.business++;if(!['GET','HEAD','OPTIONS'].includes(options.method??'GET'))counts.writes++;
  return reply({code:state.businessStatus===200?0:-1,data:{path:pathname},...(state.businessStatus>=500?{uncertain:!['GET','HEAD','OPTIONS'].includes(options.method??'GET')}: {})},state.businessStatus);
 };
 const host=createHostEndpointSession({hostExecutable:'C:/fixture/Host.exe',env:{},fetchImpl,spawnSync(){counts.status++;return{status:0,stdout:JSON.stringify({ok:true,managerBaseUrl:base,applicationGenerationId:state.generation,managerInstanceId:state.instance})};}});
 return{state,counts,context,metadata,fetchImpl,host,reply};
}

test('50 warm local RPCs reuse one mocked Host status and meta; actual server still receives every call',async()=>{
 const f=fixture(),client=createManagerClient({managerUrl:base,localHost:true,endpointSession:f.host,fetchImpl:f.fetchImpl});
 for(let index=0;index<50;index++)assert.equal((await client.request('GET','/api/fixture',{replaySafe:false})).ok,true);
 assert.deepEqual(f.counts,{status:1,public:0,self:0,meta:1,business:50,writes:0,notStarted:0});
 await client.request('GET','/meta');await client.request('GET','/meta?detail=true');assert.equal(f.counts.meta,3);assert.equal(f.counts.status,1);
});

test('an enrolled connection verifies once and reuses routing without caching any server authorization decision',async()=>{
 const f=fixture(),session=createEndpointSession({config:{managerUrl:base,managerGuid:'stable-manager',nodeId:'node',nodeCredential:'fixture-only'},fetchImpl:f.fetchImpl});
 const client=createManagerClient({managerUrl:base,credential:'fixture-only',endpointSession:session,fetchImpl:f.fetchImpl});
 for(let index=0;index<12;index++)await client.request('GET','/api/fixture',{replaySafe:false});
 assert.equal(f.counts.public,2);assert.equal(f.counts.self,1);assert.equal(f.counts.meta,1);assert.equal(f.counts.business,12);
 f.state.businessStatus=403;assert.equal((await client.request('GET','/api/fixture',{replaySafe:false})).statusCode,403);
 f.state.businessStatus=200;assert.equal((await client.request('GET','/api/fixture',{replaySafe:false})).ok,true);assert.equal(f.counts.self,1,'no cached rejection keeps the function disabled');
});

test('legacy servers keep original Host/pre/post metadata verification',async()=>{
 const f=fixture({modern:false}),client=createManagerClient({managerUrl:base,localHost:true,endpointSession:f.host,fetchImpl:f.fetchImpl});
 await client.request('GET','/api/fixture',{replaySafe:false});await client.request('GET','/api/fixture',{replaySafe:false});
 assert.equal(f.counts.status,2);assert.equal(f.counts.meta,4);assert.equal(f.counts.business,2);
});

test('a failed metadata revision refresh is shared and never holds healthy RPCs or loops the same failed revision',async()=>{
 const f=fixture(),client=createManagerClient({managerUrl:base,localHost:true,endpointSession:f.host,fetchImpl:f.fetchImpl});
 await client.request('GET','/api/fixture',{replaySafe:false});f.state.revision='r2';await client.request('GET','/api/fixture',{replaySafe:false});
 const blocked=gate();f.state.metaGate=blocked;f.state.metadataStatus=503;
 const request=client.request('GET','/api/fixture',{replaySafe:false});
 assert.equal((await request).ok,true);await client.request('GET','/api/fixture',{replaySafe:false});assert.equal(f.counts.meta,2);assert.equal(f.counts.business,4);
 blocked.release();await turn();await turn();f.state.metaGate=undefined;
 await client.request('GET','/api/fixture',{replaySafe:false});assert.equal(f.counts.meta,2);
 f.state.revision='r3';f.state.metadataStatus=200;await client.request('GET','/api/fixture',{replaySafe:false});await client.request('GET','/api/fixture',{replaySafe:false});await turn();await turn();assert.equal(f.counts.meta,3);
});

test('confirmed target rejection preserves not_started and original write identity without replay',async()=>{
 const f=fixture(),posts=[];const fetchImpl=async(url,options)=>{if(options.method==='POST')posts.push(options);return f.fetchImpl(url,options);};
 const client=createManagerClient({managerUrl:base,localHost:true,endpointSession:f.host,fetchImpl});await client.request('GET','/api/fixture',{replaySafe:false});
 f.state.generation='new-generation';f.state.instance='new-instance';
 const body={requestId:'original-write',value:1};const receipt=await client.request('POST','/api/fixture',{body,headers:{'Idempotency-Key':'original-write'}});
 assert.equal(receipt.statusCode,409);assert.equal(receipt.executionState,'not_started');assert.equal(receipt.uncertain,false);assert.equal(receipt.identityChanged,true);assert.equal(posts.length,1);assert.equal(f.counts.writes,0);
 assert.deepEqual(JSON.parse(posts[0].body),body);assert.equal(posts[0].headers['idempotency-key'],'original-write');
 assert.equal((await client.request('GET','/api/fixture',{replaySafe:false})).ok,true);assert.equal(f.counts.status,2);
});

test('missing response context keeps the old probe and unknown-write boundary while unrelated reads continue',async()=>{
 const f=fixture(),client=createManagerClient({managerUrl:base,localHost:true,endpointSession:f.host,fetchImpl:f.fetchImpl});await client.request('GET','/api/fixture',{replaySafe:false});
 f.state.dropHeader=true;f.state.metadataStatus=503;
 const write=await client.request('POST','/api/fixture',{body:{requestId:'original-missing-context'}});
 assert.equal(write.statusCode,200);assert.equal(write.uncertain,true);assert.equal(write.identityUnconfirmed,true);assert.equal(write.identityChanged,false);assert.equal(f.counts.writes,1);
 const read=await client.request('GET','/api/fixture',{replaySafe:false});assert.equal(read.ok,true);assert.equal(read.uncertain,false);assert.equal(f.counts.status,1);
});

test('a real transport failure re-discovers but never repeats the original mutation',async()=>{
 const f=fixture();let broken=false;const fetchImpl=async(url,options)=>{if(broken&&new URL(url).pathname==='/api/fixture')throw new Error('connection lost');return f.fetchImpl(url,options);};
 const client=createManagerClient({managerUrl:base,localHost:true,endpointSession:f.host,fetchImpl});await client.request('GET','/api/fixture',{replaySafe:false});broken=true;
 const result=await client.request('POST','/api/fixture',{body:{requestId:'original-interrupted'}});assert.equal(result.uncertain,true);assert.equal(result.statusCode,0);assert.equal(f.counts.writes,0);
 broken=false;await client.request('GET','/api/fixture',{replaySafe:false});assert.equal(f.counts.status,2);
});

test('late metadata and contexts do not overwrite newer cache observations or revive an invalidated route',()=>{
 const cache=createManagerEndpointCache(),meta={applicationGenerationId:'g',managerInstanceId:'i',apiTransport:{abi:1,metadataRevision:'r1'}},ctx={abi:1,applicationGenerationId:'g',managerInstanceId:'i',metadataRevision:'r1'};
 cache.remember({managerUrl:base,meta},ctx);const slow=cache.begin(),newer=cache.begin();cache.observe({...ctx,metadataRevision:'r3'},newer);
 cache.remember({managerUrl:base,meta:{...meta,apiTransport:{abi:1,metadataRevision:'r2'}}},{...ctx,metadataRevision:'r2'},slow);assert.equal(cache.needsMetadata(),true);
 cache.invalidate();cache.remember({managerUrl:base,meta},ctx,slow);assert.equal(cache.get(),undefined);
});


test('a modern module 500 stays local and does not re-discover or repeat a read',async()=>{
 const f=fixture(),client=createManagerClient({managerUrl:base,localHost:true,endpointSession:f.host,fetchImpl:f.fetchImpl});
 await client.request('GET','/api/fixture');f.state.businessStatus=500;
 const failed=await client.request('GET','/api/bad-module');assert.equal(failed.statusCode,500);assert.equal(f.counts.business,2);
 f.state.businessStatus=200;assert.equal((await client.request('GET','/api/healthy-module')).ok,true);assert.equal(f.counts.status,1);assert.equal(f.counts.meta,1);
});

for(const proxied of [true,false])test(`native ${proxied?'Manager proxy':'direct connector'} reuses only the lease guarantee its real owner provides`,async()=>{
 const f=fixture();let help=0,native=0;
 const binding={kind:'external-listener',listenerId:'native',leaseId:'lease-one',invocation:'native',authentication:{kind:'none',description:'Fixture has no native authentication'},address:{protocol:'http',hostname:'127.0.0.1',port:9876}};
 const access={kind:'manager-native-http',pathPrefix:'/api/native-listeners/lease-one',contractHeader:'x-rabiroute-native-proxy-contract',contractDigest:'sha256:'+'c'.repeat(64)};
 const contract={operationId:'fixture.native.read',contractVersion:'1.0.0',method:'GET',transport:'http',pathTemplate:'/native/status',effects:{mode:'read'},responses:{200:{mediaType:'application/json'}}};
 const operation={id:contract.operationId,contractDigest:'sha256:'+'b'.repeat(64),contract,binding,...(proxied?{access}:{})};
 const catalog={schemaVersion:'2',...f.metadata(),pluginGenerationId:'plugins',catalogRevision:1,catalogDigest:'sha256:'+'a'.repeat(64),nextCursor:'',operations:[operation]};
 const fetchImpl=async(url,options)=>{
  const parsed=new URL(url);
  if(parsed.pathname==='/api/agent/help'){help++;return f.reply({code:0,data:catalog});}
  if(parsed.origin!==base){assert.equal(options.headers.authorization,undefined);assert.equal(options.headers['x-rabiroute-listener-lease'],'lease-one');native++;return Response.json({ok:true});}
  if(parsed.pathname.startsWith(access.pathPrefix)){assert.equal(options.headers[access.contractHeader],access.contractDigest);native++;return f.reply({ok:true});}
  return f.fetchImpl(url,options);
 };
 const client=createManagerClient({managerUrl:base,credential:'fixture-only',fetchImpl});
 for(let index=0;index<2;index++)assert.equal((await client.catalog.invokeOperation(contract.operationId)).ok,true);
 assert.equal(native,2);assert.equal(f.counts.meta,1);
 assert.equal(help,proxied?1:5,'only the original guarded Manager lease mapping can omit repeated help probes');
});

test('mutable upload quota is enforced by the actual request target, not a cached lower metadata value',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'rabi-cache-quota-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const file=path.join(directory,'fixture.bin');await fs.writeFile(file,Buffer.alloc(2*1024*1024));const f=fixture();let puts=0;
 const fetchImpl=async(url,options)=>{
  if(options.method!=='PUT')return f.fetchImpl(url,options);
  puts++;let bytes=0;for await(const chunk of options.body)bytes+=chunk.length;assert.equal(bytes,2*1024*1024);
  const id=options.headers['idempotency-key'];return Response.json({code:0,data:{id,fileName:'fixture.bin',size:bytes,sha256:options.headers['x-rabiroute-content-sha256'],expiresAt:'2030-01-01T00:00:00.000Z'}},{headers:{[MANAGER_CONTEXT_HEADER]:JSON.stringify(f.context()),'idempotency-key':id}});
 };
 const client=createManagerClient({managerUrl:base,credential:'fixture-only',fetchImpl});await client.request('GET','/api/fixture');
 const result=await client.upload(file,'11111111-1111-4111-8111-111111111111');assert.equal(result.ok,true);assert.equal(puts,1);assert.equal(f.counts.meta,1);
});


test('a modern changed target first re-verifies the configured HTTPS origin instead of forcing LAN discovery',async()=>{
 const f=fixture();let discoveries=0;const managerUrl='https://manager.invalid';
 const session=createEndpointSession({config:{managerUrl,managerGuid:'stable-manager',nodeId:'node',nodeCredential:'fixture-only'},fetchImpl:f.fetchImpl,discover:async()=>{discoveries++;throw new Error('unexpected LAN discovery');}});
 const client=createManagerClient({managerUrl,credential:'fixture-only',endpointSession:session,fetchImpl:f.fetchImpl});
 await client.request('GET','/api/fixture');f.state.generation='new-https-app';f.state.instance='new-https-instance';
 const result=await client.request('GET','/api/fixture');assert.equal(result.ok,true);assert.equal(result.identity.managerInstanceId,'new-https-instance');assert.equal(discoveries,0);assert.equal(f.counts.notStarted,1);assert.equal(f.counts.business,2);
});


test('actual short CLI closes its own pending metadata refresh without cancelling the completed business receipt',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'rabi-cli-cache-close-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const configPath=path.join(directory,'config.json');await fs.writeFile(configPath,JSON.stringify({managerUrl:base,nodeCredential:'fixture-only'}));
 const f=fixture();let metas=0,aborted=false,writes=0;
 const contract={operationId:'fixture.short.write',contractVersion:'1.0.0',method:'POST',pathTemplate:'/api/short-write',transport:'http',effects:{mode:'write'},responses:{200:{mediaType:'application/json'}}};
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  const pathname=new URL(url).pathname;
  if(pathname==='/meta'){
   metas++;if(metas>1)return new Promise((resolve,reject)=>{const stop=()=>{aborted=true;reject(new Error('metadata closed'));};if(options.signal.aborted)stop();else options.signal.addEventListener('abort',stop,{once:true});});
   return f.fetchImpl(url,options);
  }
  if(pathname.startsWith('/api/agent/operations/')){f.state.revision='r2';return f.reply({code:0,data:{schemaVersion:'2',...f.metadata(),pluginGenerationId:'plugins',catalogRevision:1,catalogDigest:'sha256:'+'a'.repeat(64),operation:{id:contract.operationId,contractDigest:'sha256:'+'b'.repeat(64),contract}}});}
  writes++;return f.reply({code:0,data:{requestId:'original-short'}});
 });
 const result=await runCli(['call',contract.operationId,'--config',configPath,'--input-json','{"body":{"requestId":"original-short"}}']);
 assert.equal(result.ok,true);assert.equal(writes,1);assert.equal(metas,2);assert.equal(aborted,true);
});


test('closing one client joins only its own metadata work and leaves a shared endpoint cache usable',async()=>{
 const f=fixture(),first=createManagerClient({managerUrl:base,localHost:true,endpointSession:f.host,fetchImpl:f.fetchImpl}),second=createManagerClient({managerUrl:base,localHost:true,endpointSession:f.host,fetchImpl:f.fetchImpl});
 await first.request('GET','/api/fixture',{replaySafe:false});await first.close();assert.equal((await second.request('GET','/api/fixture',{replaySafe:false})).ok,true);
 assert.equal(f.counts.status,1);assert.equal(f.counts.meta,1);await second.close();
});
