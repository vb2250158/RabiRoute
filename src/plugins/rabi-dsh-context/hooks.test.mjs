import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { apply, Config } from './index.mjs';
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

test('DSH publishes only committed public prose proven to precede another step', async t => {
  const warning = t.mock.method(console, 'warn', () => {});
  const handlers = new Map();
  const requests = [];
  const session = { id: 'original-session', header: { cwd: '/project' } };
  const other = { id: 'another-session' };
  apply({ on: (name, fn) => handlers.set(name, fn) }, {}, async input => {
    requests.push(input);
    if (input.messageId === 'reply-1') throw new Error('isolated network failure');
    return {};
  });
  const emit = (type, data, subject = session, surfaceOp = 'append') =>
    handlers.get('session/event')(subject, { type, data, surfaceOp });
  const start = (turn, step, subject) => emit('step/start', { turn, step }, subject);
  const assistant = (turn, step, id, content, interrupted = false, surfaceOp) =>
    emit('assistant/message', { turn, step, interrupted, message: { id, role: 'assistant', content } }, session, surfaceOp);
  const blocks = [
    { type: 'reasoning', text: 'private' },
    { type: 'tool-call', text: 'private command' },
    { type: 'text', text: 'visible update' }
  ];
  assistant(1, 1, 'history', blocks);
  start(1, 2);
  emit('turn/start', { turn: 2 });
  assistant(2, 0, 'replacement', blocks, false, 'replace');
  assistant(2, 0, 'aborted', blocks, true);
  assistant(2, 0, 'reasoning-only', blocks.slice(0, 2));
  start(2, 1);
  assistant(2, 1, 'reply-1', blocks);
  start(2, 2, other);
  assert.deepEqual(requests, []);
  start(2, 2);
  start(2, 2);
  assistant(2, 2, 'reply-2', blocks);
  start(2, 3);
  assistant(2, 3, 'final', [{ type: 'text', text: 'final answer' }]);
  await handlers.get('agent/turn-stopping')({ agent: session, turn: 2 });
  emit('turn/end', { turn: 2 });
  start(2, 4);
  assert.deepEqual(requests.map(({ eventName, messageId, lastAssistantMessage }) => [eventName, messageId, lastAssistantMessage]), [
    ['AssistantProgress', 'reply-1', 'visible update'],
    ['AssistantProgress', 'reply-2', 'visible update'],
    ['Stop', undefined, 'final answer']
  ]);
  assert.equal(requests[0].turnId, '2');
  assert.equal(requests[0].sessionId, session.id);
  assert.equal(requests[0].cwd, '/project');
  assert.ok(Math.abs(Date.now() - requests[0].observedAt) < 1000);
  assert.equal(warning.mock.calls.length, 1);
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

test('the companion transport delegates each lifecycle event to the native owner', async () => {
  const handlers = new Map(), requested = [], services = new Map();
  const ctx = { on: (point, fn) => handlers.set(point, fn), get: name => services.get(name),
    effect: fn => fn(), provide: (name, service) => services.set(name, service) };
  apply(ctx, {}, async input => { requested.push(input); return {}; });
  services.set('rabiAgentHooks', { supportsCompanionTransport: true });
  const agent = { id: 'session' }, messages = [{ content: [{ type: 'text', text: 'hello' }] }];
  handlers.get('agent/created')({ agent, source: 'new' });
  const next = async () => ({ kind: 'enter', messages });
  assert.deepEqual(await handlers.get('agent/pre-step')({ agent, messages, turn: 1 }, next), await next());
  await handlers.get('tools/pre-execute')({ agent }, next);
  await handlers.get('tools/post-execute')({ agent }, {}, next);
  await handlers.get('agent/turn-stopping')({ agent, turn: 1 });
  assert.equal(requested.length, 0);
  assert.equal(typeof services.get('rabiDshHookTransport').request, 'function');
  services.delete('rabiAgentHooks');
  await handlers.get('agent/pre-step')({ agent, messages, turn: 2 }, next);
  assert.deepEqual(requested.map(event => event.eventName), ['UserPromptSubmit']);
});

test('DSH accepts only an absolute configured Host path and uses it for native transport and live progress', async () => {
  const validate = input => Config['~standard'].validate(input);
  const hostExecutable = path.resolve('RabiRouteHost fixture.exe');
  assert.deepEqual(validate({}), { value: { hostExecutable: '' } });
  assert.deepEqual(validate({ hostExecutable: '  ' }), { value: { hostExecutable: '' } });
  for (const invalid of ['RabiRouteHost.exe', 3, null]) {
    assert.deepEqual(validate({ hostExecutable: invalid }).issues[0].path, ['hostExecutable']);
  }
  const config = validate({ hostExecutable: `  ${hostExecutable}  ` }).value;
  const handlers = new Map();
  const services = new Map([['rabiAgentHooks', { supportsCompanionTransport: true }]]);
  const requests = [];
  apply({
    on: (name, handler) => handlers.set(name, handler),
    get: name => services.get(name),
    effect: fn => fn(),
    provide: (name, service) => services.set(name, service)
  }, config, async (input, options) => { requests.push({ input, options }); return {}; });
  const transport = services.get('rabiDshHookTransport');
  assert.equal(transport.hasConfiguredRoute(), true);
  await transport.request({ eventName: 'Stop' }, { hostExecutable: 'unrelated', fetch: 'fixture' });
  const session = { id: 'fixture-session' };
  const emit = (type, data) => handlers.get('session/event')(session, { type, data, surfaceOp: 'append' });
  emit('turn/start', { turn: 1 });
  emit('assistant/message', { turn: 1, step: 1, message: {
    id: 'native-id', role: 'assistant', content: [{ type: 'text', text: 'Progress' }]
  } });
  emit('step/start', { turn: 1, step: 2 });
  assert.deepEqual(requests.map(item => [item.input.eventName, item.options.hostExecutable]),
    [['Stop', hostExecutable], ['AssistantProgress', hostExecutable]]);
  assert.equal(requests[0].options.fetch, 'fixture');
  assert.equal(requests[1].input.messageId, 'native-id');
});

test('an explicitly configured Host bypasses helper and environment and rediscovers Manager for every request', async t => {
  const fsExists = fs.existsSync;
  t.mock.method(fs, 'existsSync', file => {
    assert.ok(!String(file).endsWith('hook-client.mjs'), 'explicit Host must not even probe the unrelated helper');
    return fsExists(file);
  });
  t.after(() => configureTimeouts({}));
  const hostExecutable = path.resolve('configured fixture.exe');
  let generation = 0;
  const calls = [];
  const options = {
    hostExecutable,
    execute: async (file, args) => {
      assert.equal(file, hostExecutable);
      assert.deepEqual(args, ['--command', 'status', '--json']);
      generation++;
      calls.push('status');
      return { stdout: JSON.stringify({ managerBaseUrl: `http://127.0.0.1:380${generation}`,
        applicationGenerationId: `gen-${generation}`, managerInstanceId: 'id' }) };
    },
    fetch: async (url, init) => {
      assert.ok(url.startsWith(`http://127.0.0.1:380${generation}/`));
      if (url.endsWith('/meta')) {
        calls.push('meta');
        return Response.json({ applicationGenerationId: `gen-${generation}`, managerInstanceId: 'id',
          health: { live: true, state: 'healthy' } });
      }
      calls.push('post');
      assert.equal(init.headers['x-rabiroute-expected-application-generation-id'], `gen-${generation}`);
      assert.equal(init.headers['x-rabiroute-expected-manager-instance-id'], 'id');
      return Response.json({ code: 0, data: {} });
    }
  };
  await requestHook({}, options);
  await requestHook({}, { ...options, env: { RABI_MANAGER_URL: 'http://localhost:9999', RABIROUTE_HOST_EXE: 'other.exe' } });
  assert.deepEqual(calls, ['status', 'meta', 'post', 'status', 'meta', 'post']);
});

test('configured Host failures stay on the chosen route and preserve uncertainty after dispatch', async () => {
  const hostExecutable = path.resolve('configured fixture.exe');
  for (const failure of ['status', 'identity', 'response']) {
    const calls = [];
    await assert.rejects(requestHook({}, {
      hostExecutable, env: { RABI_MANAGER_URL: 'http://localhost:9999', RABIROUTE_HOST_EXE: 'other.exe' },
      execute: async file => {
        assert.equal(file, hostExecutable);
        calls.push('status');
        if (failure === 'status') throw new Error('Host status unavailable');
        return { stdout: JSON.stringify({ managerBaseUrl: 'http://127.0.0.1:3801', applicationGenerationId: 'gen', managerInstanceId: 'id' }) };
      },
      fetch: async (url, init) => {
        assert.ok(url.startsWith('http://127.0.0.1:3801/'));
        calls.push(init.method ?? 'GET');
        if (init.method === 'POST') throw new Error('lost original response');
        return Response.json({ applicationGenerationId: failure === 'identity' ? 'other-generation' : 'gen',
          managerInstanceId: 'id', health: { live: true, state: 'healthy' } });
      }
    }), failure === 'status' ? { message: 'Host status unavailable', uncertain: false }
      : failure === 'identity' ? { message: 'RabiRoute Manager generation is not ready.', uncertain: false }
      : { message: 'lost original response', uncertain: true });
    assert.deepEqual(calls, failure === 'status' ? ['status'] : failure === 'identity' ? ['status', 'GET'] : ['status', 'GET', 'POST']);
  }
});

test('cancelling explicit Manager discovery never dispatches the hook', async () => {
  const abort = new AbortController(), requests = [];
  await assert.rejects(requestHook({ eventName: 'Stop' }, {
    env: { RABI_MANAGER_URL: 'http://localhost:12345' }, signal: abort.signal,
    fetch: async (url, { signal }) => {
      requests.push(url);
      abort.abort();
      signal.throwIfAborted();
    },
  }), { name: 'AbortError', uncertain: false });
  assert.deepEqual(requests, ['http://localhost:12345/meta']);
});

test('losing the Manager response after POST retains an uncertain outcome without replay', async () => {
  const calls = [];
  await assert.rejects(requestHook({ eventName: 'Stop' }, {
    env: { RABI_MANAGER_URL: 'http://localhost:12345' },
    fetch: async (url, options) => {
      calls.push(options.method ?? 'GET');
      if (url.endsWith('/meta')) return Response.json({ applicationGenerationId: 'gen', managerInstanceId: 'id',
        health: { live: true, state: 'healthy' } });
      throw new Error('lost response');
    },
  }), { message: 'lost response', uncertain: true });
  assert.deepEqual(calls, ['GET', 'POST']);
});
