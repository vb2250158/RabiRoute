import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RabiLinkRelayRuntime } from './rabiLinkRelayRuntime.js';
import { executeKnowledgeQueue, probeKnowledgeBridge, type KnowledgeRuntimeConfig } from './rabiLinkKnowledgeRuntime.js';
test('actual SDK HTTP queue dispatch intersects grants, denies and preserves uncertainty', async () => {
 let calls = 0, transportUnavailable = false;
 const server = http.createServer(async (req,res) => {
  if(transportUnavailable) { res.writeHead(503).end(); return; }
  if(req.headers.authorization !== `Bearer ${'x'.repeat(32)}`) {res.writeHead(401).end();return;}
  if(req.method !== 'POST') {res.writeHead(405).end();return;}
  const parts=[];for await(const p of req)parts.push(p);const body=JSON.parse(Buffer.concat(parts).toString());
  const mcp=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});
  mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'plan_list',inputSchema:{type:'object',properties:{roleId:{type:'string'}}}},{name:'plan_create',inputSchema:{type:'object'}}]}));
  mcp.setRequestHandler(CallToolRequestSchema,async()=>{calls++;return {content:[{type:'text',text:'ok'}]};});
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.once('finish',()=>{void mcp.close();});await mcp.connect(transport);await transport.handleRequest(req,res,body);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as {port:number}).port;
 const identity={appId:'app',deviceBindingId:'device',ownerAccountId:'owner',targetDeviceId:'pc'};
 const config:KnowledgeRuntimeConfig={enabled:true,url:`http://127.0.0.1:${port}/mcp`,token:'x'.repeat(32),allowedRoles:['one','two'],allowedTools:['plan_list','plan_create'],allowWrites:true,grants:[identity]};
 const metadata={...identity,grant:{allowedRoles:['one'],allowedTools:['plan_list','plan_create'],allowWrites:true}};
 try {
 assert.equal(await probeKnowledgeBridge(config),true);
 let claimed=false; const finished: any[]=[]; let advertised='';
 let eventResponse: http.ServerResponse | undefined; const extra: any[] = [];
 const relay=http.createServer(async(req,res)=>{const u=new URL(req.url!,'http://localhost');
 if(u.pathname==='/api/rabilink/events'){eventResponse=res;res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: ready\ndata: {}\n\n');return;}
 if(u.pathname==='/worker/webgui-requests'){advertised=u.searchParams.get('capabilities')||'';const requests=claimed?extra.splice(0):[{id:'valid',method:'POST',path:'/__rabilink/knowledge',knowledge:metadata,bodyBase64:Buffer.from(JSON.stringify({operation:'list'})).toString('base64')},{id:'generic',method:'POST',path:'/__rabilink/knowledge',bodyBase64:Buffer.from('{}').toString('base64')}];claimed=true;res.setHeader('content-type','application/json');res.end(JSON.stringify({requests}));return;}
 if(u.pathname.endsWith('/response')){const parts=[];for await(const p of req)parts.push(p);finished.push(JSON.parse(Buffer.concat(parts).toString()));res.end('{}');return;}res.setHeader('content-type','application/json');res.end('{"requests":[]}');});
 await new Promise<void>(r=>relay.listen(0,'127.0.0.1',r));const relayPort=(relay.address() as {port:number}).port;
 const runtime=new RabiLinkRelayRuntime();
 try {await runtime.sync({enabled:true,url:`http://127.0.0.1:${relayPort}`,token:'fixture-relay',deviceId:'pc',deviceGuid:'different-guid',deviceName:'pc',claimWaitMs:60000,localWebguiUrl:`http://127.0.0.1:${relayPort}`,speechProxyEnabled:false,localSpeechUrl:'',knowledgeBridge:config});
 const until=Date.now()+5000;while(finished.length<2&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
 assert.equal(finished.length,2);assert.ok(advertised.includes('knowledgebridge'));assert.equal(finished[0].statusCode,200);assert.equal(finished[1].statusCode,403);
 assert.equal(runtime.status().knowledgeBridgeReady,true);
  assert.ok(runtime.status().capabilities?.includes('knowledgebridge'));
  assert.equal(JSON.stringify(runtime.status()).includes(config.token!),false);
  assert.equal(JSON.stringify(runtime.status()).includes('fixture-relay'),false);
  transportUnavailable=true;
  extra.push({id:'transport-loss',method:'POST',path:'/__rabilink/knowledge',knowledge:metadata,bodyBase64:Buffer.from(JSON.stringify({operation:'call',name:'plan_list',args:{roleId:'one'}})).toString('base64')});
  eventResponse?.write('event: webgui_available\ndata: {}\n\n');
  const lossDeadline=Date.now()+5000;while(finished.length<3&&Date.now()<lossDeadline)await new Promise(r=>setTimeout(r,10));
  assert.equal(finished.length,3);assert.equal(runtime.status().knowledgeBridgeReady,false);assert.equal(runtime.status().capabilities?.includes('knowledgebridge'),false);
  await runtime.stop();assert.equal(runtime.status().knowledgeBridgeReady,false);assert.deepEqual(runtime.status().capabilities,[]);
  await runtime.sync({enabled:true,url:`http://127.0.0.1:${relayPort}`,token:'fixture-relay',deviceId:'pc',deviceGuid:'different-guid',deviceName:'pc',claimWaitMs:60000,localWebguiUrl:`http://127.0.0.1:${relayPort}`,speechProxyEnabled:false,localSpeechUrl:'',knowledgeBridge:config});
  const probeDeadline=Date.now()+5000;while(runtime.status().state==='connecting'&&Date.now()<probeDeadline)await new Promise(r=>setTimeout(r,10));
  assert.equal(runtime.status().knowledgeBridgeReady,false);assert.equal(runtime.status().capabilities?.includes('knowledgebridge'),false);
  transportUnavailable=false;
  }finally{await runtime.stop();relay.closeAllConnections();await new Promise<void>(r=>relay.close(()=>r()));}
 const list=await executeKnowledgeQueue(config,'pc',metadata,{operation:'list'},false) as {allowedRoles:string[]};assert.deepEqual(list.allowedRoles,['one']);
 await executeKnowledgeQueue(config,'pc',metadata,{operation:'call',name:'plan_list',args:{roleId:'one'}},false);assert.equal(calls,1);
 await assert.rejects(executeKnowledgeQueue(config,'other',metadata,{operation:'list'},false));
 await assert.rejects(executeKnowledgeQueue(config,'pc',metadata,{operation:'call',name:'plan_list',args:{roleId:'two'}},false));
 await assert.rejects(executeKnowledgeQueue(config,'pc',metadata,{operation:'call',name:'plan_list',args:{roleId:'one',url:'https://invalid'}},false));assert.equal(calls,1);
 } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 const uncertain=await executeKnowledgeQueue(config,'pc',metadata,{operation:'call',name:'plan_create',args:{roleId:'one',idempotencyKey:'stable-key',body:{title:'t',focus:'f',keywords:['k'],steps:[{id:'s',title:'s'}],activationStatus:'进行中',markerStatus:'active'}}},true) as {uncertain:boolean};assert.equal(uncertain.uncertain,true);
});
