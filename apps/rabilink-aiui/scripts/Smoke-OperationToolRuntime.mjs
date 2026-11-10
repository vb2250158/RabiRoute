import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApiToolRuntime } from '../utils/api-tool-runtime.js';
import { createAgentTurnRuntime } from '../utils/agent-turn-runtime.js';

const operation = (id, method = 'GET', transport = 'http') => ({ id, contractDigest: 'sha256:' + 'b'.repeat(64), contract: {
  operationId: id, contractVersion: '1.0.0', method, transport, pathTemplate: '/fixture/:id',
  request: { path: { type: 'object' }, query: { type: 'object' }, body: { kind: method === 'GET' ? 'none' : 'json' } },
  effects: { mode: method === 'GET' ? 'read' : 'write' }, responses: { '200': { mediaType: 'application/json' } },
  ...(transport === 'websocket' ? { websocket: { framing: 'json', protocol: 'fixture', maxMessageBytes: 1024, maxBufferedBytes: 2048 } } : {})
} });
const snapshot = target => ({ schemaVersion: '2', applicationGenerationId: 'app-' + target, managerInstanceId: 'manager-' + target,
  pluginGenerationId: 'plugins', catalogRevision: 1, catalogDigest: 'sha256:' + 'a'.repeat(64) });
const event = (callId, functionName, args) => ({ callId, functionName, arguments: args, isComplete: true });

async function fixture(t, entries = [operation('fixture.read'), operation('fixture.write', 'POST')]) {
  const packets = [], requests = [], rows = [], output = [];
  let outcome = { code: 0, data: { value: 'actual result' } }, uncertain = false;
  const server = http.createServer(async (request, response) => {
    const body = []; for await (const chunk of request) body.push(chunk);
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(body).toString('utf8') });
    const url = new URL(request.url, 'http://loopback'), target = request.headers['x-fixture-target'] || 'pc-one';
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/agent/categories') response.end(JSON.stringify({ code: 0, data: { ...snapshot(target), categories: [{id:'messages',title:'Messages',count:entries.length}] } }));
    else if (url.pathname === '/api/agent/operations') response.end(JSON.stringify({ code: 0, data: { ...snapshot(target), items: entries.map(entry => ({ operationId: entry.id, title: entry.id })), count: entries.length, total: entries.length, nextCursor: '' } }));
    else if (url.pathname.startsWith('/api/agent/operations/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/agent/operations/'.length)), selected = entries.find(entry => entry.id === id);
      if (!selected) { response.writeHead(404).end(JSON.stringify({code:-1,errorCode:'AGENT_HELP_NOT_FOUND',field:'operation',repair:'Search current operations.'})); return; }
      response.end(JSON.stringify({ code: 0, data: { ...snapshot(target), operation: selected } }));
    } else { response.writeHead(uncertain ? 504 : 200).end(JSON.stringify(outcome)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const runtime = createApiToolRuntime({ defaultTargetDeviceId: 'pc-one', sessionId: 'fixture-session',
    storage: { load: async () => rows, save: async value => { rows.splice(0, rows.length, ...structuredClone(value)); } },
    onResult: value => output.push(value),
    call: async packet => {
      packets.push(structuredClone(packet));
      if (packet.mode) return { structuredContent: { ok: true, statusCode: packet.mode === 'websocket' ? 101 : 200,
        operationId: packet.operationId, data: { mode: packet.mode, complete: true } } };
      const response = await fetch(url + packet.path, { method: packet.method,
        headers: { ...packet.headers, 'x-fixture-target': packet.targetDeviceId || 'pc-one' },
        ...(packet.body === undefined ? {} : { body: JSON.stringify(packet.body) }) });
      return { structuredContent: { ok: response.ok, statusCode: response.status, uncertain: uncertain && !packet.path.startsWith('/api/agent/'),
        headers: Object.fromEntries(response.headers), data: await response.json() } };
    }
  });
  t.after(async () => { runtime.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return {runtime, packets, requests, rows, output, outcome(value) { outcome = value; }, uncertain(value) { uncertain = value; }};
}

test('canonical categories and Chinese search decode Manager envelopes through the existing phone transport', async t => {
  const f = await fixture(t);
  const tools = await f.runtime.loadTools();
  assert.ok(tools.some(tool => tool.function.name === 'rabi_categories'));
  const categories = await f.runtime.handleToolCall(event('categories', 'rabi_categories', {}));
  assert.equal(categories.result.structuredContent.data.categories[0].id, 'messages');
  const searched = await f.runtime.handleToolCall(event('search', 'rabi_search', { query: '群聊 历史', category: 'messages', limit: 20, targetDeviceId: 'pc-two' }));
  assert.equal(searched.result.structuredContent.data.items[0].operationId, 'fixture.read');
  const request = new URL(f.requests.at(-1).url, 'http://loopback');
  assert.equal(request.searchParams.get('query'), '群聊 历史'); assert.equal(request.searchParams.get('category'), 'messages');
  assert.equal(f.packets.at(-1).targetDeviceId, 'pc-two'); assert.equal(f.rows.length, 0);
});

test('canonical write preserves structured input, target, ETag and separate request identity', async t => {
  const f = await fixture(t);
  const result = await f.runtime.handleToolCall(event('write', 'rabi_call', { operation: 'fixture.write', requestId: 'original-request',
    expectedRevision: '"revision-one"', targetDeviceId: 'pc-two', input: { pathParams: {id:'one / two'}, query: {tag:['first','second']}, body: {value:'中文'} } }));
  const request = f.requests.at(-1);
  assert.equal(request.url, '/fixture/one%20%2F%20two?tag=first&tag=second');
  assert.equal(request.headers['idempotency-key'], 'original-request'); assert.equal(request.headers['if-match'], '"revision-one"');
  assert.equal(request.headers['x-rabiroute-api-contract'], 'sha256:' + 'b'.repeat(64));
  assert.deepEqual(JSON.parse(request.body), {value:'中文'});
  assert.equal(result.result.structuredContent.operation, 'fixture.write'); assert.equal(result.result.structuredContent.requestId, 'original-request');
  assert.equal(f.rows[0].operationId, 'original-request'); assert.notEqual(f.rows[0].operationId, 'fixture.write');
  assert.ok(f.packets.every(packet => packet.targetDeviceId === 'pc-two'));
});

test('canonical errors retain the field and repair without marking a not-started request uncertain', async t => {
  const f = await fixture(t);
  for (const args of [{operation:'fixture.write',expectedRevison:'typo'}, {input:{}}, {operation:'fixture.write',input:'not-object'}]) {
    const result = await f.runtime.handleToolCall(event('bad-' + f.output.length, 'rabi_call', args));
    assert.equal(result.result.isError, true); assert.equal(result.result.structuredContent.uncertain, false);
    assert.equal(result.result.structuredContent.error.errorCode, 'TOOL_ARGUMENTS_INVALID');
    assert.match(result.result.structuredContent.error.repair, /expectedRevision/);
  }
  assert.equal(f.packets.length, 0);
  const missing = await f.runtime.handleToolCall(event('absent', 'rabi_describe', {operation:'missing'}));
  assert.equal(missing.result.structuredContent.statusCode, 404); assert.equal(missing.result.structuredContent.error.errorCode, 'AGENT_HELP_NOT_FOUND');
  assert.equal(f.rows.length, 0);
});

test('canonical binary and long-connection observations retain the original target and packet contracts', async t => {
  const f = await fixture(t, [operation('binary.write','POST'),operation('events.read','GET','sse'),operation('socket.open','GET','websocket')]);
  const bytes = Buffer.from([0,255,128,1]);
  await f.runtime.handleToolCall(event('binary','rabi_call',{operation:'binary.write',requestId:'binary-key',input:{pathParams:{id:'bytes'},bodyBase64:bytes.toString('base64')}}));
  assert.equal(f.packets.at(-1).bodyBase64, bytes.toString('base64'));
  const stream = await f.runtime.handleToolCall(event('events','rabi_call',{operation:'events.read',input:{pathParams:{id:'events'},maxBytes:4096,maxMs:1000}}));
  assert.equal(f.packets.at(-1).mode,'stream'); assert.equal(f.packets.at(-1).maxBytes,4096);
  assert.equal(stream.result.structuredContent.operation,'events.read');
  await f.runtime.handleToolCall(event('socket','rabi_call',{operation:'socket.open',requestId:'frames-key',targetDeviceId:'pc-two',input:{pathParams:{id:'socket'},messages:['hello'],protocols:['fixture.v1']}}));
  const packet=f.packets.at(-1);assert.equal(packet.mode,'websocket');assert.equal(packet.targetDeviceId,'pc-two');assert.equal(packet.operationId,'frames-key');assert.deepEqual(packet.messages,['hello']);
});

test('an uncertain canonical write is not replayed by the same key or moved to another PC', async t => {
  const f=await fixture(t);f.uncertain(true);
  const args={operation:'fixture.write',requestId:'stable-original',input:{pathParams:{id:'one'},body:{value:1}}};
  const first=await f.runtime.handleToolCall(event('first','rabi_call',args));
  assert.equal(first.result.structuredContent.uncertain,true);
  const second=await f.runtime.handleToolCall(event('second','rabi_call',args));assert.equal(second.duplicate,true);assert.equal(second.uncertain,true);
  await assert.rejects(f.runtime.handleToolCall(event('third','rabi_call',{...args,targetDeviceId:'pc-two'})),/TOOL_OPERATION_TARGET_CONFLICT/);
  assert.equal(f.requests.filter(request=>request.url==='/fixture/one').length,1);
});

test('disposing during description never starts the later canonical mutation', async () => {
  let resolve, writes=0;
  const pending=new Promise(done=>{resolve=done;});
  const runtime=createApiToolRuntime({sessionId:'fixture',defaultTargetDeviceId:'pc-one',storage:{load:()=>[],save:()=>{}},call:async packet=>{
    if(packet.path.startsWith('/api/agent/operations/')){await pending;return {structuredContent:{ok:true,statusCode:200,data:{code:0,data:{...snapshot('pc-one'),operation:operation('late.write','POST')}}}};}
    writes++;return {structuredContent:{ok:true,data:{}}};
  }});
  const result=runtime.handleToolCall(event('pending','rabi_call',{operation:'late.write',input:{pathParams:{id:'one'}}}));
  await new Promise(done=>setImmediate(done));runtime.dispose();resolve();
  assert.equal((await result).cancelled,true);assert.equal(writes,0);
});


test('a business contract change invalidates only the selected SDK cache without replay', async () => {
  let rows=[], descriptionReads=0, calls=0;
  const current=operation('changing.read');
  const runtime=createApiToolRuntime({sessionId:'cache',defaultTargetDeviceId:'pc-one',storage:{load:()=>rows,save:value=>{rows=value;}},call:async packet=>{
    if(packet.path.startsWith('/api/agent/operations/')){
      descriptionReads++;
      return {structuredContent:{ok:true,statusCode:200,data:{code:0,data:{...snapshot('pc-one'),catalogRevision:descriptionReads,operation:structuredClone(current)}}}};
    }
    calls++;
    if(calls===1)return {structuredContent:{ok:false,statusCode:409,data:{code:-1,errorCode:'API_CONTRACT_CHANGED'}}};
    return {structuredContent:{ok:true,statusCode:200,data:{code:0,data:{path:packet.path}}}};
  }});
  const first=await runtime.handleToolCall(event('first','rabi_call',{operation:'changing.read',input:{pathParams:{id:'one'}}}));
  assert.equal(first.result.structuredContent.statusCode,409);assert.equal(calls,1);
  current.contract.pathTemplate='/updated/:id';
  const second=await runtime.handleToolCall(event('second','rabi_call',{operation:'changing.read',input:{pathParams:{id:'one'}}}));
  assert.equal(second.result.structuredContent.data.data.path,'/updated/one');assert.equal(descriptionReads,2);assert.equal(calls,2);
  runtime.dispose();
});


test('the Agent turn does not repeat an uncertain canonical write and can continue healthy reads', async () => {
  let rows=[],writes=0,reads=0,step=0;
  const write=operation('notes.write','POST'),read=operation('notes.read');
  const runtime=createApiToolRuntime({sessionId:'canonical-turn',defaultTargetDeviceId:'pc-one',storage:{load:()=>rows,save:value=>{rows=value;}},call:async packet=>{
    if(packet.path.startsWith('/api/agent/operations/')){
      const id=decodeURIComponent(packet.path.split('/').at(-1).split('?')[0]);
      return {structuredContent:{ok:true,statusCode:200,data:{code:0,data:{...snapshot('pc-one'),operation:id==='notes.write'?write:read}}}};
    }
    if(packet.method==='POST'){writes++;return {structuredContent:{ok:false,uncertain:true,statusCode:504,data:{code:-1,errorCode:'UNKNOWN_WRITE'}}};}
    reads++;return {structuredContent:{ok:true,statusCode:200,data:{code:0,data:{healthyRead:true}}}};
  }});
  const original={operation:'notes.write',input:{pathParams:{id:'original'},body:{value:1}}};
  const observations=[];
  const model={prompt:async input=>{
    const packet=JSON.parse(input[0].content);if(packet.observation)observations.push(packet.observation);step++;
    const args=step===1||step===2?original:step===3?{operation:'notes.read',input:{pathParams:{id:'original'}}}:step===4?{operation:'notes.write',input:{pathParams:{id:'second'},body:{value:2}}}:null;
    return JSON.stringify(args?{protocol:'rabi-agent/v1',requestId:packet.requestId,kind:'tool',name:'rabi_call',arguments:args}:{protocol:'rabi-agent/v1',requestId:packet.requestId,kind:'final',text:'原写入待核对，读取正常。'});
  }};
  const turn=createAgentTurnRuntime({model,tools:await runtime.loadTools(),executeTool:event=>runtime.handleToolCall(event)});
  const result=await turn.run('记录结果并查看状态');
  assert.equal(result.state,'uncertain');assert.equal(writes,1);assert.equal(reads,1);
  assert.equal(observations[0].callId,observations[1].callId,'repeated intent observes the original call');
  assert.equal(observations[2].outcome.result.structuredContent.data.data.healthyRead,true);
  assert.equal(observations[3].outcome.result.structuredContent.code,'WRITE_RECONCILIATION_REQUIRED');
  assert.equal(rows.length,2,'only the original write and healthy read enter the actual call ledger');runtime.dispose();
});

test('a canonical transport rejection keeps the original mutation known to the Agent turn',async()=>{
  let rows=[];
  const runtime=createApiToolRuntime({sessionId:'throwing-call',storage:{load:()=>rows,save:value=>{rows=value;}},call:async packet=>{
    if(packet.path.startsWith('/api/agent/operations/'))return {structuredContent:{ok:true,statusCode:200,data:{code:0,data:{...snapshot('local'),operation:operation('throw.write','POST')}}}};
    throw Error('controlled transport disconnect');
  }});
  const result=await runtime.handleToolCall(event('original','rabi_call',{operation:'throw.write',input:{pathParams:{id:'one'}}}));
  assert.equal(result.mutation,true);assert.equal(result.uncertain,true);assert.equal(result.result.structuredContent.code,'API_OUTCOME_UNCONFIRMED');
  assert.equal(rows[0].state,'pending');runtime.dispose();
});


test('unsupported local-file and native-connector options report the exact field before dispatch',async t=>{
  const f=await fixture(t);
  for(const input of [{outputPath:'synthetic-output.bin'},{nativeHeaders:{authorization:'synthetic-native'}}]){
    const result=await f.runtime.handleToolCall(event('unsupported-'+f.output.length,'rabi_call',{operation:'fixture.write',input}));
    assert.equal(result.result.structuredContent.error.errorCode,'TOOL_TRANSPORT_OPTION_UNAVAILABLE');
    assert.equal(result.result.structuredContent.error.field,'input.'+Object.keys(input)[0]);
    assert.equal(result.result.structuredContent.uncertain,false);
  }
  assert.equal(f.packets.length,0);assert.equal(f.rows.length,0);
});


test('touching GET effects keep mutation identity while an explicit read-only POST remains a read',async()=>{
  let rows=[];const calls=[];
  const touch=operation('memory.touch');touch.contract.effects.mode='native-recent-memory-touch-unless-read-only';
  const query=operation('catalog.query','POST');query.contract.effects.mode='read';
  const runtime=createApiToolRuntime({sessionId:'effects',storage:{load:()=>rows,save:value=>{rows=value;}},call:async packet=>{
    if(packet.path.startsWith('/api/agent/operations/')){
      const id=decodeURIComponent(packet.path.split('/').at(-1).split('?')[0]);return {structuredContent:{ok:true,statusCode:200,data:{code:0,data:{...snapshot('local'),operation:id==='memory.touch'?touch:query}}}};
    }
    calls.push(packet);return {structuredContent:{ok:true,statusCode:200,data:{code:0,data:{}}}};
  }});
  const touchResult=await runtime.handleToolCall(event('touch','rabi_call',{operation:'memory.touch',input:{pathParams:{id:'memory'}}}));
  assert.equal(touchResult.mutation,true);assert.equal(calls[0].operationId,'effects:touch');assert.equal(calls[0].headers['idempotency-key'],'effects:touch');
  const queryResult=await runtime.handleToolCall(event('query','rabi_call',{operation:'catalog.query',input:{pathParams:{id:'catalog'},body:{limit:1}}}));
  assert.equal(queryResult.mutation,false);assert.equal(calls[1].method,'POST');runtime.dispose();
});


test('local receipt persistence and presentation failures preserve the accepted canonical outcome',async()=>{
  let rows=[],saves=0,writes=0;
  const runtime=createApiToolRuntime({sessionId:'local-receipt',storage:{load:()=>rows,save:value=>{if(++saves===2)throw Error('controlled durable failure');rows=value;}},onResult:()=>{throw Error('controlled presentation failure');},call:async packet=>{
    if(packet.path.startsWith('/api/agent/operations/'))return {structuredContent:{ok:true,statusCode:200,data:{code:0,data:{...snapshot('local'),operation:operation('accepted.write','POST')}}}};
    writes++;return {structuredContent:{ok:true,statusCode:200,data:{code:0,data:{committed:true}}}};
  }});
  const first=await runtime.handleToolCall(event('original','rabi_call',{operation:'accepted.write',requestId:'original-key',input:{pathParams:{id:'one'}}}));
  assert.equal(first.mutation,true);assert.equal(first.uncertain,true);assert.equal(first.result.structuredContent.code,'TOOL_RECEIPT_PERSISTENCE_FAILED');
  assert.equal(first.result.structuredContent.data.data.committed,true);assert.equal(first.result.structuredContent.requestId,'original-key');
  const duplicate=await runtime.handleToolCall(event('repeat','rabi_call',{operation:'accepted.write',requestId:'original-key',input:{pathParams:{id:'one'}}}));
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.uncertain,true);assert.equal(writes,1);runtime.dispose();
  const f=createApiToolRuntime({sessionId:'display-only',storage:{load:()=>[],save:()=>{}},onResult:()=>{throw Error('controlled presentation failure');},call:async()=>({structuredContent:{ok:true,statusCode:200,data:{code:0,data:{...snapshot('local'),categories:[]}}}})});
  assert.equal((await f.handleToolCall(event('categories','rabi_categories',{}))).result.structuredContent.ok,true);f.dispose();
});
