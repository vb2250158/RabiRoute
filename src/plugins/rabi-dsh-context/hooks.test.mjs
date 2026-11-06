import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from './index.mjs';
import { requestHook } from './manager-client.mjs';
import { configureTimeouts } from './timeout-settings.mjs';

test('DSH consumes the startup discovery budget and verified Manager request budget', async t => {
  configureTimeouts({});
  t.after(() => configureTimeouts({}));
  const budgets = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => { budgets.push(milliseconds); return new AbortController().signal; });
  let hostBudget;
  const result = await requestHook({}, {
    env: { RABIROUTE_HOST_EXE: 'fixture-host', RABIROUTE_TIMEOUT_OVERRIDES: JSON.stringify({ 'hooks.dsh.discovery': 37, 'hooks.manager.discovery': 43 }) },
    execute: async (_file, _args, options) => {
      hostBudget = options.timeout;
      return { stdout: JSON.stringify({ managerBaseUrl: 'http://localhost:12345', applicationGenerationId: 'generation', managerInstanceId: 'instance' }) };
    },
    fetch: async url => url.endsWith('/meta')
      ? Response.json({ applicationGenerationId: 'generation', managerInstanceId: 'instance', health: { live: true, state: 'healthy', requiredReady: true }, timeoutOverrides: { 'hooks.manager.request': 73 } })
      : Response.json({ code: 0, data: { additionalContext: 'fixture' } })
  });
  assert.equal(hostBudget, 37);
  assert.deepEqual(budgets, [43, 73]);
  assert.equal(result.additionalContext, 'fixture');
});

test('DSH forwards lifecycle identity and obeys Manager decisions without local policies', async () => {
  const handlers = new Map();
  const requests = [];
  const injected = [];
  const agent = { id: 'session-one', inject: value => injected.push(value) };
  apply({ on: (event, handler) => handlers.set(event, handler) }, {}, async request => {
    requests.push(request);
    return request.eventName === 'PreToolUse'
      ? { toolDecision: { permissionDecision: 'deny', reason: 'persona policy' } }
      : { additionalContext: 'manager context' };
  });
  handlers.get('agent/created')({ agent, source: 'resume' });
  const messages = [{ content: [{ type: 'text', text: 'hello' }] }];
  const decision = await handlers.get('agent/pre-step')({ agent, messages, turn: 3 }, async () => ({ kind: 'enter', messages }));
  assert.equal(decision.messages.length, 2);
  assert.deepEqual(decision.messages[1].source, { kind: 'rabi-dsh-context', form: 'notice', summary: 'Rabi 角色上下文' });
  assert.deepEqual(requests.slice(0, 2).map(item => item.eventName), ['SessionStart', 'UserPromptSubmit']);
  const requestCount = requests.length;
  const retainedContext = [decision.messages[1]];
  await handlers.get('agent/pre-step')({ agent, messages: retainedContext, turn: 3 }, async () => ({ kind: 'enter', messages: retainedContext }));
  assert.equal(requests.length, requestCount);
  let executed = false;
  const denied = await handlers.get('tools/pre-execute')({ agent, name: 'pwsh', arguments: {}, callId: 'call-1' }, async () => { executed = true; });
  assert.equal(denied.kind, 'deny');
  assert.equal(executed, false);
  handlers.get('session/event')({ id: agent.id }, { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: 'done' }] } } });
  await handlers.get('agent/turn-stopping')({ agent, turn: 3 });
  assert.equal(requests.at(-1).lastAssistantMessage, 'done');
  assert.equal(requests.at(-1).sessionId, agent.id);
});

test('DSH keeps independent execution when Manager is absent', async t => {
  const warning = t.mock.method(console, 'warn', () => {});
  const handlers = new Map();
  apply({ on: (event, handler) => handlers.set(event, handler) }, {}, async () => { throw new Error('offline'); });
  const result = await handlers.get('tools/pre-execute')({ agent: { id: 'unbound' } }, async () => ({ kind: 'allow' }));
  assert.equal(result.kind, 'allow');
  assert.equal(warning.mock.calls.at(-1).arguments[1], 'offline');
});

test('DSH rejects a stale Host generation before forwarding events', async () => {
  const urls = [];
  await assert.rejects(requestHook({}, {
    env: { RABIROUTE_HOST_EXE: 'host' },
    execute: async () => ({ stdout: JSON.stringify({ managerBaseUrl: 'http://localhost:12345', applicationGenerationId: 'new', managerInstanceId: 'one' }) }),
    fetch: async url => { urls.push(url); return { ok: true, json: async () => ({ health: { live: true, state: 'healthy', requiredReady: true }, applicationGenerationId: 'old' }) }; }
  }), /generation/);
  assert.equal(urls.length, 1);
});

for (const source of ['startup', 'resume', 'clear', 'compact']) {
  test(`DSH sends SessionStart once after an entered step (${source})`, async () => {
    const handlers = new Map();
    const requests = [];
    const agent = { id: `lifecycle-${source}`, session: { header: { origin: 'subagent' } } };
    apply({ on: (event, handler) => handlers.set(event, handler) }, {}, async request => {
      requests.push(request);
      return { additionalContext: 'start context' };
    });
    assert.equal(handlers.has('agent/session-start'), false);
    handlers.get('agent/created')({ agent, source });
    assert.equal(requests.length, 0);
    await handlers.get('agent/pre-step')({ agent, messages: [], turn: 1 }, async () => ({ kind: 'reject' }));
    assert.equal(requests.length, 0);
    const decision = await handlers.get('agent/pre-step')({ agent, messages: [], turn: 1 }, async () => ({ kind: 'enter', messages: [] }));
    assert.equal(decision.messages.length, 1);
    await handlers.get('agent/pre-step')({ agent, messages: [], turn: 1 }, async () => ({ kind: 'enter', messages: [] }));
    assert.deepEqual(requests.map(item => [item.eventName, item.source]), [['SessionStart', source]]);
    handlers.get('agent/disposed')({ agent });
    handlers.get('agent/created')({ agent, source: 'resume' });
    await handlers.get('agent/pre-step')({ agent, messages: [], turn: 2 }, async () => ({ kind: 'enter', messages: [] }));
    assert.deepEqual(requests.map(item => item.source), [source, 'resume']);
  });
}


test('DSH requires complete identity for explicit URLs and Host discovery before forwarding', async () => {
  for (const explicit of [false, true]) for (const missing of [{}, {applicationGenerationId:'generation'}, {applicationGenerationId:' ',managerInstanceId:'manager'}]) {
    let requests = 0;
    await assert.rejects(requestHook({}, {
      env: explicit ? { RABI_MANAGER_URL:'http://localhost:12345' } : {RABIROUTE_HOST_EXE:'fixture-host'},
      execute:async()=>({stdout:JSON.stringify({managerBaseUrl:'http://localhost:12345',...missing})}),
      fetch:async()=>{ requests++; return Response.json({...missing,health:{live:true,state:'healthy'}}); }
    }), /generation/);
    assert.equal(requests,1);
  }
});

test('DSH accepts a live degraded Manager with exact identity and fences its hook request', async t => {
  t.after(()=>configureTimeouts({}));
  const identity={applicationGenerationId:'generation',managerInstanceId:'manager'}, calls=[];
  const value=await requestHook({eventName:'SessionStart'}, {
    env:{RABI_MANAGER_URL:'http://localhost:12345'},
    fetch:async(url,init)=>{calls.push(url);if(url.endsWith('/meta'))return Response.json({...identity,health:{live:true,state:'degraded',requiredReady:false}});
      assert.equal(init.headers['x-rabiroute-expected-application-generation-id'],identity.applicationGenerationId);
      assert.equal(init.headers['x-rabiroute-expected-manager-instance-id'],identity.managerInstanceId);
      return Response.json({code:0,data:{additionalContext:'healthy feature'}});}
  });
  assert.equal(value.additionalContext,'healthy feature');assert.equal(calls.length,2);
});
