import fs from 'node:fs/promises';
import http from 'node:http';
import {once} from 'node:events';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket,WebSocketServer} from 'ws';
import {createHash,randomUUID} from 'node:crypto';
const transportFixtureAccess = randomUUID();
const renewalFixtureAccess = randomUUID();
import {createApiToolRuntime} from '../utils/api-tool-runtime.js';
import {createAgentTurnRuntime} from '../utils/agent-turn-runtime.js';
import {AGENT_PROTOCOL} from '../utils/agent-decision-protocol.js';
import {formatApiResult} from '../utils/api-result-view.js';

test('private paired Eye client preserves buffered binary, SSE and actual WebSocket bytes',async t=>{
  const requests=[],binary=Buffer.from([0,255,1,128]);
  const server=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);requests.push({path:req.url,headers:req.headers,body});
    if(req.url==='/session'){assert.equal(req.headers['x-rabi-pairing'],'fixture-pairing');assert.equal(JSON.parse(body).deviceToken,'fixture-eye-token');res.setHeader('content-type','application/json');res.end(JSON.stringify({code:0,data:{sourceDeviceId:'glasses-0123456789abcdef',accessToken:transportFixtureAccess,expiresAt:Date.now()+900000}}));return;}
    if(req.headers.authorization!==('Bearer '+transportFixtureAccess)){res.writeHead(403);res.end();return;}
    if(req.url==='/manager-http'){res.setHeader('content-type','application/json');const packet=JSON.parse(body);res.end(JSON.stringify({code:0,data:{structuredContent:{ok:true,statusCode:206,headers:{'x-future':'original'},bodyBase64:binary.toString('base64'),data:packet.request.path==='/meta'?{applicationGenerationId:'actual-generation',managerInstanceId:'actual-manager',health:{live:true,requiredReady:true,state:'healthy'}}:'binary'},transportCapabilities:{transport:'lan',sourceDeviceId:'glasses-0123456789abcdef'}}}));return;}
    if(req.url==='/manager-stream'){res.writeHead(200,{'content-type':'text/event-stream','x-future':'stream'});res.write('data: first\n\n');setTimeout(()=>res.end(binary),20);return;}
    res.writeHead(404);res.end();
  });
  let disconnectedWrites=0;
  const wsServer=new WebSocketServer({noServer:true});wsServer.on('connection',(socket,request)=>socket.on('message',(bytes,binary)=>{if(request.headers['x-rabi-manager-path']==='/future/partial-write'){disconnectedWrites++;socket.send(bytes,{binary},()=>socket.terminate());}else socket.send(bytes,{binary});}));
  server.on('upgrade',(req,socket,head)=>{assert.equal(req.headers.authorization,('Bearer '+transportFixtureAccess));assert.equal(req.url,'/manager-ws');wsServer.handleUpgrade(req,socket,head,client=>wsServer.emit('connection',client,req));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{wsServer.close();server.closeAllConnections();server.close();});
  const base='http://127.0.0.1:'+server.address().port,storage=new Map();
  let socketTaskMode=false;
  const wx={getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,structuredClone(value)),removeStorageSync:key=>storage.delete(key),request(options){fetch(options.url,{method:options.method,headers:options.header,body:JSON.stringify(options.data)}).then(async response=>options.success({statusCode:response.status,data:await response.json()})).catch(options.fail);},connectSocket(options){const header={...options.header};const protocols=header['sec-websocket-protocol']?.split(',')||[];delete header['sec-websocket-protocol'];const socket=new WebSocket(options.url,protocols,{headers:header});if(!socketTaskMode)return socket;return{onOpen:fn=>socket.on('open',fn),onMessage:fn=>socket.on('message',(bytes,isBinary)=>fn({data:isBinary?bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length):bytes.toString()})),onError:fn=>socket.on('error',fn),onClose:fn=>socket.on('close',fn),send:data=>socket.send(data),close:()=>socket.close()};}};
  const source=await fs.readFile(new URL('../utils/phone-eye-transport.js',import.meta.url),'utf8');const storeSource=await fs.readFile(new URL('../utils/rabilink-store.js',import.meta.url),'utf8');const context=vm.createContext({wx,URL,Date,Math,fetch,AbortController,Uint8Array,ArrayBuffer,setTimeout,clearTimeout});
  context.tokenStorageKey=vm.runInContext('(()=>{'+storeSource.replace(/^import .*;\r?\n/gm,'').replaceAll('export ','')+';return tokenStorageKey})()',context);
  const api=vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replaceAll('export ','')+';({pairPhoneEyeTransport,phoneEyeHttpRequest,phoneEyeStreamRequest,phoneEyeOpenWebSocket,phoneEyeTransportStatus})',context);
  const config={relayBaseUrl:'https://relay.invalid',token:'fixture-eye-token'};await api.pairPhoneEyeTransport(config,base,'fixture-pairing');config.phoneBridgeRef=api.phoneEyeTransportStatus(config).ref;
  const packet={targetDeviceId:'persona-pc-b',request:{method:'PATCH',path:'/future/not-in-catalog',body:{anything:42},operationId:'original-write'}};
  const result=await api.phoneEyeHttpRequest(config,packet);assert.equal(result.structuredContent.statusCode,206);assert.deepEqual(Buffer.from(result.structuredContent.bodyBase64,'base64'),binary);assert.equal(result.transportCapabilities.sourceDeviceId,'glasses-0123456789abcdef');
  const chunks=[];let head;await api.phoneEyeStreamRequest(config,{targetDeviceId:'pc-c',request:{method:'GET',path:'/future/events'}},{onHead:value=>head=value,onData:value=>chunks.push(Buffer.from(value))});assert.equal(head.headers['x-future'],'stream');assert.deepEqual(Buffer.concat(chunks),Buffer.concat([Buffer.from('data: first\n\n'),binary]));
  const socket=await api.phoneEyeOpenWebSocket(config,{targetDeviceId:'pc-c',request:{path:'/future/socket'}});await once(socket,'open');const received=once(socket,'message');socket.send(binary);assert.deepEqual((await received)[0],binary);socket.close();await once(socket,'close');
  assert.ok(requests.every(row=>!row.path.includes(transportFixtureAccess)));assert.ok(!JSON.stringify(storage.get('rabilink-private-phone-edge-v1')).includes('fixture-eye-token'));
  const before=requests.length;await assert.rejects(api.phoneEyeHttpRequest({...config,phoneBridgeRef:'changed'},packet),/CONNECTION_CHANGED/);assert.equal(requests.length,before);
  assert.equal(await api.phoneEyeHttpRequest({...config,relayBaseUrl:'https://other.invalid',phoneBridgeRef:''},packet),null);
  // Actual Agent loop -> actual page tool runtime -> paired stream/socket -> original observation.
  socketTaskMode=true;context.requestManagerStream=api.phoneEyeStreamRequest;context.openManagerWebSocket=api.phoneEyeOpenWebSocket;
  const streamSource=await fs.readFile(new URL('../utils/api-stream-tool.js',import.meta.url),'utf8');context.callApiStreamTool=vm.runInContext('(()=>{'+streamSource.replace(/^import .*;\r?\n/gm,'').replaceAll('export ','')+';return callApiStreamTool})()',context);
  context.createApiToolRuntime=createApiToolRuntime;context.requestDeviceApi=async(config,packet)=>api.phoneEyeHttpRequest(config,packet);context.getMobileState=()=>{throw Error('frozen target already present');};context.formatApiResult=formatApiResult;
  const pageSource=await fs.readFile(new URL('../utils/api-tool-page.js',import.meta.url),'utf8');const methods=vm.runInContext(pageSource.replace(/^import .*;\r?\n/gm,'').replaceAll('export ','')+';apiToolPageMethods',context);
  const page={...methods,deviceAgentProfileConfig:()=>({...config,targetDeviceId:'persona-pc-b'}),config:()=>config,deviceAgentProfile:{personaRef:{sourceDeviceId:'persona-pc-b'}},agentProfileScope:()=>config.relayBaseUrl, destroyed:false,setKnowledgePageData(){},speakText(){}};
  const prepared=await page.prepareRabiApiTools();assert.ok(prepared.tools[1].function.parameters.properties.mode.enum.includes('stream'));
  let steps=0;const observed=[];const model={async prompt(input){const message=JSON.parse(input[0].content);if(message.observation)observed.push(message.observation);steps++;const action=steps===1?{method:'GET',path:'/future/events',mode:'stream',targetDeviceId:'ledger-pc-c',maxMs:1000}:steps===2?{method:'GET',path:'/future/socket',mode:'websocket',targetDeviceId:'pc-d',messages:[{bodyBase64:binary.toString('base64')}],maxMessages:1,maxMs:1000}:null;return JSON.stringify(action?{protocol:AGENT_PROTOCOL,requestId:message.requestId,kind:'tool',name:'rabi_api_call',arguments:action}:{protocol:AGENT_PROTOCOL,requestId:message.requestId,kind:'final',text:'已收到原事件流和二进制消息。'});}};
  const turn=createAgentTurnRuntime({model,tools:prepared.tools,executeTool:event=>page.handleRabiApiToolCall(event)});const outcome=await turn.run('读取未来流和双向消息');assert.equal(outcome.state,'uncertain');assert.equal(steps,3);assert.equal(observed.length,2);
  const streamResult=observed[0].outcome.result.structuredContent.data;assert.equal(streamResult.mode,'stream');assert.deepEqual(Buffer.concat(streamResult.chunksBase64.map(value=>Buffer.from(value,'base64'))),Buffer.concat([Buffer.from('data: first\n\n'),binary]));
  const wsResult=observed[1].outcome.result.structuredContent;assert.equal(wsResult.data.mode,'websocket');assert.deepEqual(Buffer.from(wsResult.data.messages[0].bodyBase64,'base64'),binary);assert.ok(wsResult.operationId);assert.equal(wsResult.uncertain,true);
  assert.ok(requests.some(row=>row.headers['x-rabi-manager-target']==='ledger-pc-c'));page.cleanupRabiApiRuntime();
  const second=await page.prepareRabiApiTools();let partialSteps=0;const partialObservations=[];
  const write={method:'GET',path:'/future/partial-write',mode:'websocket',messages:['write-once'],targetDeviceId:'pc-d',maxMs:1000};
  const partialModel={async prompt(input){const message=JSON.parse(input[0].content);if(message.observation)partialObservations.push(message.observation);partialSteps++;return JSON.stringify(partialSteps<=2?{protocol:AGENT_PROTOCOL,requestId:message.requestId,kind:'tool',name:'rabi_api_call',arguments:write}:{protocol:AGENT_PROTOCOL,requestId:message.requestId,kind:'final',text:'收到部分帧；业务写入未确认，需要回读原结果。'});}};
  const partial=createAgentTurnRuntime({model:partialModel,tools:second.tools,executeTool:event=>page.handleRabiApiToolCall(event)});assert.equal((await partial.run('写入后断连')).state,'uncertain');assert.equal(disconnectedWrites,1);assert.equal(partialObservations.length,2);assert.equal(partialObservations[0].callId,partialObservations[1].callId);assert.equal(partialObservations[0].outcome.result.structuredContent.uncertain,true);page.cleanupRabiApiRuntime();
});

test('original paired device renews beyond fifteen minutes; revoked, expired and changed scopes never dispatch',async t=>{
  let clock=100000,expiry=0,revoked=false,renewals=0,writes=0;
  const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;res.setHeader('content-type','application/json');
    if(req.url==='/session'){assert.equal(JSON.parse(body).deviceToken,'original-eye-token');expiry=clock+900000;res.end(JSON.stringify({code:0,data:{sourceDeviceId:'glasses-0123456789abcdef',accessToken:renewalFixtureAccess,expiresAt:expiry}}));return;}
    if(req.headers.authorization!==('Bearer '+renewalFixtureAccess)||clock>=expiry||revoked){res.writeHead(403);res.end('{}');return;}
    if(req.url==='/session/renew'){renewals++;expiry=clock+900000;res.end(JSON.stringify({code:0,data:{sourceDeviceId:'glasses-0123456789abcdef',expiresAt:expiry}}));return;}
    if(req.url==='/manager-http'){writes++;res.end(JSON.stringify({code:0,data:{structuredContent:{ok:true,operationId:JSON.parse(body).request.operationId}}}));return;}res.writeHead(404);res.end('{}');
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const storage=new Map(),wx={getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,structuredClone(value)),removeStorageSync:key=>storage.delete(key),request(options){fetch(options.url,{method:options.method,headers:options.header,body:JSON.stringify(options.data)}).then(async response=>options.success({statusCode:response.status,data:await response.json()})).catch(options.fail);}};
  let heartbeat=null;const context=vm.createContext({wx,URL,Date:class extends Date{static now(){return clock;}},Math,setTimeout:fn=>{heartbeat=fn;return 1;},clearTimeout:()=>{heartbeat=null;}});context.tokenStorageKey=token=>token;
  const source=await fs.readFile(new URL('../utils/phone-eye-transport.js',import.meta.url),'utf8');const api=vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replaceAll('export ','')+';({pairPhoneEyeTransport,phoneEyeHttpRequest,phoneEyeTransportStatus,clearPhoneEyeTransport})',context);t.after(()=>api.clearPhoneEyeTransport());
  const config={relayBaseUrl:'https://relay.invalid',token:'original-eye-token'},url='http://127.0.0.1:'+server.address().port;
  await api.pairPhoneEyeTransport(config,url,'pair');const originalRef=api.phoneEyeTransportStatus(config).ref;config.phoneBridgeRef=originalRef;
  const packet=index=>({targetDeviceId:'pc-original',request:{method:'POST',path:'/future/write',operationId:'original:'+index,body:{index}}});
  for(let index=0;index<3;index++){clock+=11*60*1000;assert.ok(heartbeat);await heartbeat();assert.equal(writes,index);await api.phoneEyeHttpRequest(config,packet(index));assert.equal(api.phoneEyeTransportStatus(config).ref,originalRef);}
  assert.equal(renewals,3);assert.equal(writes,3);assert.ok(clock>100000+15*60*1000);
  revoked=true;clock+=11*60*1000;await assert.rejects(api.phoneEyeHttpRequest(config,packet('revoked')),/REJECTED/);assert.equal(writes,3);assert.equal(api.phoneEyeTransportStatus(config).configured,true);assert.equal(api.phoneEyeTransportStatus(config).active,false);await assert.rejects(api.phoneEyeHttpRequest(config,packet('still-disabled')),/PAIRING_REQUIRED/);assert.equal(writes,3);
  revoked=false;config.phoneBridgeRef='';await api.pairPhoneEyeTransport(config,url,'pair');config.phoneBridgeRef=api.phoneEyeTransportStatus(config).ref;
  assert.equal(await api.phoneEyeHttpRequest({...config,relayBaseUrl:'https://changed.invalid',phoneBridgeRef:''},packet('changed')),null);assert.equal(writes,3);
  clock+=16*60*1000;await assert.rejects(api.phoneEyeHttpRequest(config,packet('expired')),/PAIRING_REQUIRED/);assert.equal(writes,3);assert.equal(renewals,3);
});
