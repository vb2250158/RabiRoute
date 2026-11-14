import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createAgentTurnRuntime } from '../utils/agent-turn-runtime.js';
import { AGENT_PROTOCOL, agentLoopModelOptions } from '../utils/agent-decision-protocol.js';
import { createApiToolRuntime } from '../utils/api-tool-runtime.js';
import { createPageAssistantFixture } from './AssistantSessionFixture.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const message = input => JSON.parse(input[0].content);
const action = (input, name, args, extra = {}) => JSON.stringify({ protocol: AGENT_PROTOCOL, requestId: message(input).requestId, kind: 'tool', name, arguments: args, ...extra });
const final = (input, text) => JSON.stringify({ protocol: AGENT_PROTOCOL, requestId: message(input).requestId, kind: 'final', text });
const ok = data => ({ result: { structuredContent: { ok: true, data } } });
function toolRuntime(call) {
  let rows = [];
  return createApiToolRuntime({ sessionId: 'fixture', storage: { load: () => rows, save: next => { rows = next; } }, call });
}

test('same Rokid session reads live help, calls a future API and reasons from the actual receipt', async () => {
  const requests = [], calls = [], spoken = [];
  const tools = toolRuntime(async packet => { calls.push(packet); return { structuredContent: { ok: true, data: packet.path === '/api/agent/help?limit=32' ? { next: '/api/future' } : { count: 37 } } }; });
  const host = { addEventListener() { throw Error('no second native execution path'); }, async prompt(input) {
    requests.push(input); const step = requests.length;
    if (step === 1) return action(input, 'rabi_api_help', {});
    if (step === 2) { assert.equal(message(input).observation.outcome.result.structuredContent.data.next, '/api/future'); return action(input, 'rabi_api_call', { method: 'GET', path: '/api/future' }); }
    assert.equal(message(input).observation.outcome.result.structuredContent.data.count, 37);
    return final(input, '查到 37 条。');
  } };
  const turn = createAgentTurnRuntime({ model: host, tools: await tools.loadTools(), executeTool: event => tools.handleToolCall(event), onText: value => spoken.push(value.delta) });
  const result = await turn.run('查询未来接口');
  assert.equal(result.state, 'completed'); assert.equal(result.steps, 3); assert.equal(result.toolResults.length, 2);
  assert.deepEqual(calls.map(row => row.path), ['/api/agent/help?limit=32','/api/future']); assert.deepEqual(spoken, ['查到 37 条。']);
  assert.ok(requests.every(input => input.length === 1 && input[0].role === 'user'));
  assert.equal(message(requests[1]).untrusted, true);
});

test('model options retain the persona, use host default model and declare application tools only', () => {
  const base = { initialPrompts: [{ role: 'system', content: '角色指引' }], tools: [{ type: 'function', function: { name: 'close_app', parameters: {} } }] };
  const result = agentLoopModelOptions(base, [{ type: 'function', function: { name: 'rabi_api_call', parameters: {} } }]);
  assert.equal(result.options.model, undefined); assert.deepEqual(result.options.tools, []);
  assert.ok(result.options.initialPrompts[0].content.endsWith('\n\n角色指引'));
  assert.ok(result.options.initialPrompts[0].content.includes('rabi_api_call'));
  assert.equal(result.tools.length, 2); assert.equal(base.tools.length, 1); assert.equal(base.initialPrompts[0].content, '角色指引');
});

test('HTTP settlement precedes the next model request; equivalent writes keep one original outcome', async () => {
  const pending = deferred(); const inputs = []; let calls = 0;
  const host = { async prompt(input) {
    inputs.push(input);
    if (inputs.length === 1) return action(input, 'rabi_api_call', { method: 'POST', path: '/api/future', body: { a: 1, b: 2 } });
    if (inputs.length === 2) return action(input, 'rabi_api_call', { body: { b: 2, a: 1 }, path: '/api/future', method: 'POST' });
    assert.equal(message(input).observation.callId, message(inputs[1]).observation.callId); return '已核对回执。';
  } };
  const turn = createAgentTurnRuntime({ model: host, tools: ['rabi_api_call'], executeTool: async () => { calls++; await pending.promise; return ok({ receipt: 'original' }); } });
  const run = turn.run('保存'); await tick(); assert.equal(inputs.length, 1); assert.equal(calls, 1);
  pending.resolve(); assert.equal((await run).state, 'completed'); assert.equal(calls, 1); assert.equal(inputs.length, 3);
});

test('unknown write outcome blocks subsequent writes but permits readback and stays uncertain', async () => {
  const calls = []; let step = 0;
  const host = { async prompt(input) {
    step++;
    if (step === 1) return action(input, 'rabi_api_call', { method: 'POST', path: '/api/first' });
    if (step === 2) return action(input, 'rabi_api_call', { method: 'POST', path: '/api/different' });
    if (step === 3) { assert.equal(message(input).observation.outcome.code, 'WRITE_RECONCILIATION_REQUIRED'); assert.equal(message(input).observation.dispatched, false); return action(input, 'rabi_api_call', { method: 'GET', path: '/api/operations/original' }); }
    return '原请求仍待核对。';
  } };
  const turn = createAgentTurnRuntime({ model: host, tools: ['rabi_api_call'], executeTool: async event => {
    calls.push(event.arguments.method); return calls.length === 1 ? { uncertain: true, operationId: 'original' } : ok({ state: 'pending' });
  } });
  assert.equal((await turn.run('保存')).state, 'uncertain'); assert.deepEqual(calls, ['POST','GET']);
});

test('a lost API response gives the model the generated original operation for readback', async () => {
  const packets = [], inputs = [];
  let rows = [], original;
  const api = createApiToolRuntime({ sessionId: 'recovery-session', defaultTargetDeviceId: 'pc-original',
    storage: { load: () => structuredClone(rows), save: value => { rows = structuredClone(value); } },
    call: async packet => {
      packets.push(packet);
      if (packet.method === 'POST') {
        original = packet.operationId;
        throw Error('private transport diagnostic that must not reach the model');
      }
      assert.equal(packet.path, '/api/fixture/receipts/' + encodeURIComponent(original));
      return { structuredContent: { ok: true, data: { operationId: original, state: 'committed' } } };
    }
  });
  const model = { async prompt(input) {
    inputs.push(input);
    if (inputs.length === 1) return action(input, 'rabi_api_call', { method: 'POST', path: '/api/fixture/write' });
    const outcome = message(input).observation.outcome;
    if (inputs.length === 2) {
      assert.equal(outcome.uncertain, true);
      assert.equal(outcome.requestIdentity.operationId, original);
      assert.equal(outcome.requestIdentity.targetDeviceId, 'pc-original');
      assert.equal(outcome.requestIdentity.callId, 'recovery-turn:call-1');
      assert.ok(!JSON.stringify(outcome).includes('private transport diagnostic'));
      // This receipt path belongs to the fixture's known API contract.
      return action(input, 'rabi_api_call', { method: 'GET', targetDeviceId: outcome.requestIdentity.targetDeviceId,
        path: '/api/fixture/receipts/' + encodeURIComponent(outcome.requestIdentity.operationId) });
    }
    assert.equal(outcome.result.structuredContent.data.state, 'committed');
    return final(input, '已查询原请求回执。');
  } };
  const result = await createAgentTurnRuntime({ model, turnId: 'recovery-turn', tools: await api.loadTools(),
    executeTool: event => api.handleToolCall(event) }).run('保存并按原请求查询回执');
  assert.equal(result.state, 'uncertain');
  assert.deepEqual(packets.map(packet => packet.method), ['POST', 'GET']);
  assert.equal(rows[0].state, 'uncertain');
  const duplicate = await api.handleToolCall({ callId: 'later-call', functionName: 'rabi_api_call', isComplete: true,
    arguments: { method: 'POST', path: '/api/fixture/write', operationId: original } });
  assert.equal(duplicate.requestIdentity.operationId, original);
  assert.equal(duplicate.resultAvailable, false);
  assert.equal(packets.length, 2);
});

test('receipt storage failure preserves the returned result and original operation without replay', async () => {
  let rows = [], saves = 0, calls = 0;
  const dependencies = { sessionId: 'persist-session', defaultTargetDeviceId: 'pc-original',
    storage: { load: () => structuredClone(rows), save: value => {
      if (++saves === 2) throw Error('storage unavailable');
      rows = structuredClone(value);
    } },
    call: async () => { calls++; return { structuredContent: { ok: true, data: { receipt: 'real-result' } } }; }
  };
  const event = { callId: 'save', functionName: 'rabi_api_call', isComplete: true,
    arguments: { method: 'PUT', path: '/api/fixture/write' } };
  const output = await createApiToolRuntime(dependencies).handleToolCall(event);
  assert.equal(output.uncertain, true);
  assert.equal(output.code, 'TOOL_RECEIPT_SAVE_UNCONFIRMED');
  assert.equal(output.requestIdentity.operationId, 'persist-session:save');
  assert.equal(output.result.structuredContent.data.receipt, 'real-result');
  assert.equal(rows[0].state, 'pending');
  const duplicate = await createApiToolRuntime(dependencies).handleToolCall(event);
  assert.equal(duplicate.uncertain, true);
  assert.equal(duplicate.requestIdentity.operationId, output.requestIdentity.operationId);
  assert.equal(calls, 1);
});

test('malformed, stale and undeclared actions never reach an HTTP executor or TTS', async () => {
  for (const reply of [() => '{"kind":"tool"', input => action(input,'unknown',{}, { say: '我已开始执行。' }), input => action(input,'rabi_api_call',{}, { requestId: 'old-step' })]) {
    let calls = 0; const shown = [];
    const host = { prompt: async input => reply(input) };
    await assert.rejects(createAgentTurnRuntime({ model: host, tools: ['rabi_api_call'], executeTool: async () => { calls++; return ok({}); }, onText: value => shown.push(value.text) }).run('查询'));
    assert.equal(calls, 0); assert.deepEqual(shown, []);
  }
});

test('Rabi receipts without an outcome cannot certify completion or permit another write', async () => {
  for (const receipt of [{}, { result: {} }, { result: { structuredContent: {} } }, 1, { local: true, terminal: true, requested: true }]) {
    let step = 0, calls = 0;
    const model = { prompt: async input => ++step <= 2
      ? action(input, 'rabi_api_call', { method: 'POST', path: '/api/operation-' + step })
      : '回执需要核对。' };
    const result = await createAgentTurnRuntime({ model, tools: ['rabi_api_call'],
      executeTool: async () => { calls++; return receipt; }
    }).run('保存');
    assert.equal(result.state, 'uncertain');
    assert.equal(calls, 1);
  }
});

test('partial JSON followed by transport failure cannot execute a half-written action', async () => {
  let calls = 0, reads = 0, fallback = 0; const shown = [];
  const host = { promptStreaming() { return { read: async () => { if (reads++ === 0) return { value: '{"protocol":"rabi-agent/v1",' }; throw Error('network'); } }; }, prompt() { fallback++; } };
  await assert.rejects(createAgentTurnRuntime({ model: host, tools: ['rabi_api_call'], executeTool: async () => { calls++; }, onText: value => shown.push(value.text) }).run('查询'), /network/);
  assert.equal(calls, 0); assert.equal(fallback, 0); assert.deepEqual(shown, []);
});

test('plain stream failure preserves actual partial text without a fallback request', async () => {
  let reads = 0, fallback = 0; const shown = [];
  const host = { promptStreaming() { return { read: async () => { if (reads++ === 0) return { value: '部分回答' }; throw Error('network'); } }; }, prompt() { fallback++; } };
  await assert.rejects(createAgentTurnRuntime({ model: host, executeTool: async () => ok({}), onText: value => shown.push(value.text) }).run('查询'), /network/);
  assert.deepEqual(shown, ['部分回答']); assert.equal(fallback, 0);
});

test('timeout cancels the current reader and suppresses late output', async () => {
  const pending = deferred(); const shown = []; let cancelled = 0;
  const host = { promptStreaming: () => ({ read: () => pending.promise, cancel() { cancelled++; } }) };
  await assert.rejects(createAgentTurnRuntime({ model: host, executeTool: async () => ok({}), requestTimeoutMs: 10, onText: value => shown.push(value.text) }).run('查询'), /TURN_TIMEOUT/);
  pending.resolve({ value: '迟到回答' }); await tick(); assert.equal(cancelled, 1); assert.deepEqual(shown, []);
});

test('cancelling a dispatched tool leaves its outcome unclaimed and starts no second model request', async () => {
  const pending = deferred(); let requests = 0, calls = 0;
  const host = { prompt: async input => { requests++; return action(input,'rabi_api_call',{method:'POST',path:'/api/future'}); } };
  const turn = createAgentTurnRuntime({ model: host, tools: ['rabi_api_call'], executeTool: async () => { calls++; await pending.promise; return ok({}); } });
  const run = turn.run('保存'); await tick(); turn.cancel(); assert.equal((await run).state, 'cancelled'); pending.resolve(); await tick();
  assert.equal(requests, 1); assert.equal(calls, 1);
});

test('guidance after inference supersedes an undispatched write and continues on the same model', async () => {
  const pending = deferred(); const inputs = []; let hints = [], calls = 0;
  const host = { async prompt(input) { inputs.push(input); if (inputs.length === 1) { await pending.promise; return action(input,'rabi_api_call',{method:'POST',path:'/api/old'}); } return '已采用新引导。'; } };
  const turn = createAgentTurnRuntime({ model: host, tools: ['rabi_api_call'], executeTool: async () => { calls++; }, takeGuidance() { const next = hints; hints = []; return next; } });
  const run = turn.run('原任务'); await tick(); hints = ['先查新的任务']; pending.resolve(); await run;
  assert.equal(calls, 0); assert.equal(inputs.length, 2); assert.equal(message(inputs[1]).kind, 'steering'); assert.equal(message(inputs[1]).actionExecuted, false);
});

test('guidance during HTTP execution waits for actual outcome before changing the next decision', async () => {
  const pending = deferred(); const inputs = []; let hints = [];
  const host = { async prompt(input) { inputs.push(input); return inputs.length === 1 ? action(input,'rabi_api_call',{method:'POST',path:'/api/first'}) : '已核对原操作，再采用引导。'; } };
  const turn = createAgentTurnRuntime({ model: host, tools: ['rabi_api_call'], executeTool: async () => { await pending.promise; return ok({ receipt:'actual' }); }, takeGuidance() { const next = hints; hints = []; return next; } });
  const run = turn.run('原任务'); await tick(); hints = ['随后读取记录']; assert.equal(inputs.length, 1); pending.resolve(); await run;
  assert.deepEqual(message(inputs[1]).steering, ['随后读取记录']); assert.equal(message(inputs[1]).observation.outcome.result.structuredContent.data.receipt, 'actual');
});

test('local exit ends the turn without another model request and flushes its spoken sentence', async () => {
  let requests = 0, calls = 0; const shown = [];
  const host = { prompt: async input => { requests++; return action(input, 'close_app', {}, { say: '正在退出' }); } };
  const result = await createAgentTurnRuntime({ model: host, tools: ['close_app'],
    executeTool: async () => { calls++; return { local: true, terminal: true, requested: true }; },
    onText: value => shown.push(value.delta)
  }).run('退出应用');
  assert.equal(result.state, 'completed'); assert.equal(requests, 1); assert.equal(calls, 1);
  assert.deepEqual(shown, ['正在退出\n']);
});

test('step limits and oversized output stop execution with actionable errors', async () => {
  let calls = 0;
  const host = { prompt: async input => action(input,'rabi_api_call',{method:'GET',path:'/api/future'}) };
  await assert.rejects(createAgentTurnRuntime({ model: host, tools:['rabi_api_call'], maxSteps:2, executeTool:async()=>{ calls++;return ok({}); } }).run('查询'),/TURN_STEP_LIMIT/); assert.equal(calls,2);
  const shown=[]; await assert.rejects(createAgentTurnRuntime({ model:{prompt:async()=> 'x'.repeat(16001)},executeTool:async()=>ok({}),onText:value=>shown.push(value.text)}).run('查询'),/TURN_RESPONSE_LIMIT/);assert.deepEqual(shown,[]);
});

test('main page stays busy across the application loop and applies persona changes only after completion', async () => {
  const source=fs.readFileSync(new URL('../pages/home/index.ink',import.meta.url),'utf8'); const start=source.indexOf('  async executeChatTool('), end=source.indexOf('  cleanupChatModel()',start);
  const profileSource=fs.readFileSync(new URL('../utils/agent-profile-page.js',import.meta.url),'utf8');
  const readiness=profileSource.slice(profileSource.indexOf('  isAiuiVoiceContextReady() {'),profileSource.indexOf('  invalidateAiuiVoiceContext() {')).trim().replace(/,$/,'');
  const methods=vm.runInNewContext('({'+readiness+','+source.slice(start,end).trim().replace(/,$/,'')+'})',{createAgentTurnRuntime,requestTimeout:(_config,_target,_key,fallback)=>fallback,console,navigator:{onLine:true},wx:{}});
  const pending=deferred();let requests=0,applied=0;
  const host={prompt:async input=> ++requests===1?action(input,'rabi_api_call',{method:'GET',path:'/api/future'}):'已查询。'};
  const page={...methods,config:()=>({}),currentAgentProfileScope:()=>'',pageVisible:true,data:{},chatModelAgentTools:['rabi_api_call'],setData(patch){Object.assign(this.data,patch);},speakText(){},applyPendingDeviceAgentProfile(){applied++;},applyPendingApiTools(){},chatModelApiRuntime:{ handleToolCall:async()=>{await pending.promise;return ok({});} }};
  const assistant = createPageAssistantFixture(page, host); page.ensureChatModel = async () => assistant;
  const run=page.executeLingzhuAgentPrompt('查询');await tick();assert.equal(page.deviceAgentTurnActive,true);assert.equal(page.data.assistantModelBusy,true);assert.equal(applied,1);assert.equal(requests,1);
  pending.resolve();await run;assert.equal(requests,2);assert.equal(page.deviceAgentTurnActive,false);assert.equal(applied,2);assistant.dispose();
});
