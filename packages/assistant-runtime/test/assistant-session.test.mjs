import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantSession } from '../src/assistant-session.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const parse = input => JSON.parse(input[0].content);
const action = (input, name, args) => JSON.stringify({ protocol: parse(input).protocol, requestId: parse(input).requestId, kind: 'tool', name, arguments: args });
const policy = { classify: value => ({ mutation: value.name === 'api.call' && value.arguments.method !== 'GET' }),
  inspectOutcome: result => ({ uncertain: !result || result.status === 'unknown', failed: result?.status === 'failed', terminal: false }) };
const backend = (options = {}) => ({ tools: [], executeTool: async () => ({ status: 'ok' }), toolPolicy: policy, ...options });

test('binding checks fence model creation after discovery and prompting after model initialization', async () => {
  for (const delayed of ['discovery', 'model']) {
    const pending = deferred();
    let valid = true, creations = 0, prompts = 0, destroyed = 0;
    const client = createAssistantSession({ profile: { systemPrompt: 'test' },
      discoverTools: async () => { if (delayed === 'discovery') await pending.promise; return backend(); },
      createModel: async () => {
        creations++;
        if (delayed === 'model') await pending.promise;
        return { prompt() { prompts++; return 'unexpected'; }, destroy() { destroyed++; } };
      }
    });
    const run = client.run('old target', { assertCurrent() { if (!valid) throw new Error('TASK_STALE'); } });
    const rejected = assert.rejects(run, /TASK_STALE/);
    await tick();
    valid = false;
    pending.resolve();
    await rejected;
    assert.equal(prompts, 0);
    assert.equal(creations, delayed === 'discovery' ? 0 : 1);
    assert.equal(destroyed, creations);
    client.dispose();
  }
});

test('binding change while a model is replying prevents tool dispatch', async () => {
  const pending = deferred();
  let valid = true, dispatched = 0;
  const client = createAssistantSession({ profile: { systemPrompt: 'test' },
    discoverTools: () => backend({ tools: [{ function: { name: 'api.call' } }], executeTool() { dispatched++; } }),
    createModel: () => ({ async prompt(input) { await pending.promise; return action(input, 'api.call', { method: 'POST' }); } })
  });
  const run = client.run('write', { assertCurrent() { if (!valid) throw new Error('TASK_STALE'); } });
  const rejected = assert.rejects(run, /TASK_STALE/);
  await tick();
  valid = false;
  pending.resolve();
  await rejected;
  assert.equal(dispatched, 0);
  client.dispose();
});

test('an already dispatched tool settles once and stale bindings block further inference', async () => {
  const pending = deferred();
  let valid = true, dispatched = 0, prompts = 0, settled = 0;
  const client = createAssistantSession({ profile: { systemPrompt: 'test' },
    discoverTools: () => backend({ tools: [{ function: { name: 'api.call' } }],
      async executeTool() { dispatched++; await pending.promise; settled++; return { status: 'ok' }; } }),
    createModel: () => ({ prompt(input) { prompts++; return action(input, 'api.call', { method: 'POST' }); } })
  });
  const run = client.run('write', { assertCurrent() { if (!valid) throw new Error('TASK_STALE'); } });
  const rejected = assert.rejects(run, error => {
    assert.match(error.message, /TASK_STALE/);
    assert.deepEqual(error.pendingGuidance, ['next input']);
    return true;
  });
  await tick();
  client.guide('next input');
  valid = false;
  pending.resolve();
  await rejected;
  assert.equal(dispatched, 1);
  assert.equal(settled, 1);
  assert.equal(prompts, 1);
  client.dispose();
});

test('global prompt, discovered API tools, lookup and invocation run through one host session', async () => {
  const settings = [], calls = []; let creations = 0, discovery = 0, step = 0;
  const client = createAssistantSession({ profile: { systemPrompt: '全局提示词：自然对话，依据真实回执工作。' },
    discoverTools: async () => { discovery++; return backend({
      tools: ['api.find', 'api.call'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
      executeTool: async event => {
        calls.push(event);
        return event.functionName === 'api.find'
          ? { status: 'ok', schema: { method: 'GET', path: '/future/counter', parameters: {} } }
          : { status: 'ok', count: 37, receiptId: 'observed-1' };
      }
    }); },
    createModel: async options => { creations++; settings.push(options); return { prompt: async input => {
      if (++step === 1) return action(input, 'api.find', { query: '计数' });
      if (step === 2) { assert.equal(parse(input).observation.outcome.schema.path, '/future/counter'); return action(input, 'api.call', { method: 'GET', path: '/future/counter' }); }
      if (step === 3) { assert.equal(parse(input).observation.outcome.count, 37); return '查到 37 条。'; }
      return '继续对话。';
    } }; }
  });
  await Promise.all([client.ready(), client.ready()]);
  assert.equal((await client.run('查计数')).text, '查到 37 条。');
  assert.equal((await client.run('再聊一句')).text, '继续对话。');
  assert.equal(creations, 1); assert.equal(discovery, 1);
  assert.equal(settings[0].initialPrompts[0].role, 'system');
  assert.ok(settings[0].initialPrompts[0].content.endsWith('全局提示词：自然对话，依据真实回执工作。'));
  assert.equal(settings[0].initialPrompts[0].content.split('全局提示词：').length, 2);
  assert.match(settings[0].initialPrompts[0].content, /api.find/);
  assert.deepEqual(settings[0].tools, []);
  assert.deepEqual(calls.map(value => value.functionName), ['api.find', 'api.call']);
  client.dispose();
});

test('profile/tool refresh waits for original tool settlement and preserves its target-bound executor', async () => {
  const pending = deferred(), prompts = [], sources = []; let steps = 0, destroyed = 0;
  const client = createAssistantSession({ profile: { systemPrompt: '旧人格', target: 'host-a' },
    discoverTools: async ({ profile }) => backend({ tools: [{ function: { name: 'api.call' } }],
      executeTool: async () => { sources.push(profile.target); await pending.promise; return { status: 'ok', receiptId: 'original' }; }
    }),
    createModel: async options => { prompts.push(options.initialPrompts[0].content); return {
      destroy() { destroyed++; }, prompt: async input => ++steps === 1 ? action(input, 'api.call', { method: 'POST' }) : '依据原回执继续。'
    }; }
  });
  const run = client.run('开始'); await tick();
  assert.deepEqual(client.configure({ systemPrompt: '新人格', target: 'host-b' }), { applied: false, deferred: true });
  assert.equal(client.refreshTools().deferred, true);
  assert.equal(client.guide('核对后再继续').accepted, true);
  assert.equal(prompts.length, 1); assert.equal(destroyed, 0);
  await assert.rejects(client.run('并发'), /ASSISTANT_BUSY/);
  pending.resolve(); await run;
  assert.deepEqual(sources, ['host-a']); assert.equal(destroyed, 1);
  await client.run('下一轮');
  assert.equal(prompts.length, 2); assert.match(prompts[1], /\n\n新人格$/);
  assert.doesNotMatch(prompts[1], /旧人格/);
  client.dispose();
});

test('failed discovery is explicit and retry discovers tools again', async () => {
  let discoveries = 0, creations = 0;
  const client = createAssistantSession({ profile: { systemPrompt: '系统提示' },
    discoverTools: async () => { if (++discoveries === 1) throw Error('discovery unavailable'); return backend(); },
    createModel: async () => { creations++; return { prompt: async () => '正常' }; }
  });
  await assert.rejects(client.run('查接口'), /discovery unavailable/);
  assert.equal(client.getState().busy, false);
  assert.equal((await client.run('重试')).text, '正常');
  assert.equal(discoveries, 2); assert.equal(creations, 1);
  client.dispose();
});

test('creation timeout destroys the late model and releases the original tool adapter', async () => {
  const pending = deferred(); let destroyed = 0, disposed = 0;
  const client = createAssistantSession({ profile: { systemPrompt: '系统提示' }, initializationTimeoutMs: 15,
    discoverTools: async () => backend({ dispose() { disposed++; } }), createModel: () => pending.promise
  });
  await assert.rejects(client.ready(), /ASSISTANT_INITIALIZATION_TIMEOUT/);
  pending.resolve({ prompt: async () => '迟到', destroy() { destroyed++; } }); await tick();
  assert.equal(destroyed, 1); assert.equal(disposed, 1); assert.equal(client.getState().ready, false);
  client.dispose();
});

test('profile replacement rejects old initialization without disposing the replacement', async () => {
  const pending = deferred(); let creations = 0, oldDestroyed = 0, currentDestroyed = 0;
  const client = createAssistantSession({ profile: { systemPrompt: '旧' }, discoverTools: async () => backend(),
    createModel: async () => ++creations === 1 ? pending.promise : { prompt: async () => '新', destroy() { currentDestroyed++; } }
  });
  const old = client.ready(); const rejection = assert.rejects(old, /ASSISTANT_INITIALIZATION_CANCELLED/); await tick();
  client.configure({ systemPrompt: '新' }); await client.ready();
  pending.resolve({ prompt: async () => '旧', destroy() { oldDestroyed++; } }); await rejection; await tick();
  assert.equal(oldDestroyed, 1); assert.equal(currentDestroyed, 0);
  assert.equal((await client.run('查询')).text, '新');
  client.dispose(); assert.equal(currentDestroyed, 1);
});

test('cancel during initialization makes no request and disposed sessions cannot restart', async () => {
  const pending = deferred(); let calls = 0, releases = 0;
  const client = createAssistantSession({ profile: { systemPrompt: '系统提示' }, discoverTools: async () => backend(),
    createModel: () => pending.promise
  });
  const running = client.run('任务'); await tick(); client.cancel();
  assert.equal((await running).state, 'cancelled');
  pending.resolve({ prompt() { calls++; }, destroy() { releases++; } }); await tick();
  assert.equal(calls, 0); assert.equal(releases, 1);
  client.dispose(); await assert.rejects(client.ready(), /ASSISTANT_CLOSED/);
  await assert.rejects(client.run('任务'), /ASSISTANT_CLOSED/);
});

test('final narration cannot falsely acknowledge guidance after the last decision boundary', async () => {
  let reply;
  const client = createAssistantSession({ profile: { systemPrompt: '系统提示' }, discoverTools: async () => backend(),
    createModel: async () => ({ prompt: async input => JSON.stringify({ protocol: parse(input).protocol,
      requestId: parse(input).requestId, kind: 'final', text: '本轮已结束。' }) }),
    onText: () => { reply = client.guide('还有一句'); }
  });
  await client.run('回答');
  assert.deepEqual(reply, { accepted: false, reason: 'finishing' });
  client.dispose();
});

test('terminal tools return accepted but unconsumed guidance without reopening or replaying the tool', async () => {
  const pending = deferred(); let requests = 0, calls = 0;
  const client = createAssistantSession({ profile: { systemPrompt: '系统提示' },
    discoverTools: async () => backend({ tools: [{ function: { name: 'view.exit' } }],
      toolPolicy: { ...policy, inspectOutcome: () => ({ uncertain: false, failed: false, terminal: true }) },
      executeTool: async () => { calls++; await pending.promise; return { status: 'ok', terminal: true }; }
    }),
    createModel: async () => ({ prompt: async input => { requests++; return action(input, 'view.exit', {}); } })
  });
  const running = client.run('退出'); await tick();
  assert.equal(client.guide('保留这句，下次继续').accepted, true);
  pending.resolve(); const result = await running;
  assert.deepEqual(result.pendingGuidance, ['保留这句，下次继续']);
  assert.equal(result.state, 'completed'); assert.equal(requests, 1); assert.equal(calls, 1);
  assert.deepEqual(client.guide('已经结束'), { accepted: false, reason: 'idle' });
  client.dispose();
});

test('cancel and dispose return queued guidance while dispatched work keeps its original owner', async () => {
  for (const operation of ['cancel', 'dispose']) {
    const pending = deferred(); let calls = 0;
    const client = createAssistantSession({ profile: { systemPrompt: '系统提示' },
      discoverTools: async () => backend({ tools: [{ function: { name: 'api.call' } }],
        executeTool: async () => { calls++; await pending.promise; return { status: 'ok' }; } }),
      createModel: async () => ({ prompt: async input => action(input, 'api.call', { method: 'POST' }) })
    });
    const running = client.run('开始'); await tick();
    assert.equal(client.guide('未消费的补充').accepted, true);
    client[operation]();
    const result = await running;
    assert.equal(result.state, 'cancelled');
    assert.deepEqual(result.pendingGuidance, ['未消费的补充'], operation);
    pending.resolve(); await tick(); assert.equal(calls, 1);
    client.dispose();
  }
});

test('initialization cancellation and timeout return input accepted before model creation', async () => {
  for (const operation of ['cancel', 'timeout']) {
    const pending = deferred(); let destroyed = 0;
    const client = createAssistantSession({ profile: { systemPrompt: '系统提示' }, initializationTimeoutMs: 20,
      discoverTools: async () => backend(), createModel: () => pending.promise });
    const running = client.run('开始');
    assert.equal(client.guide('创建中补充').accepted, true);
    if (operation === 'cancel') {
      client.cancel();
      assert.deepEqual((await running).pendingGuidance, ['创建中补充']);
    } else {
      await assert.rejects(running, error => error.code === 'ASSISTANT_INITIALIZATION_TIMEOUT'
        && assert.deepEqual(error.pendingGuidance, ['创建中补充']) === undefined);
    }
    pending.resolve({ prompt: async () => '迟到', destroy() { destroyed++; } }); await tick();
    if (operation === 'timeout') assert.equal(destroyed, 1);
    client.dispose();
  }
});

test('model errors and turn deadlines return only guidance not already handed to the model', async () => {
  for (const mode of ['model-error', 'tool-timeout']) {
    const pending = deferred(); let calls = 0;
    const original = Object.freeze(Object.assign(new Error('host failure'), { code: 'HOST_MODEL_FAILED' }));
    const client = createAssistantSession({ profile: { systemPrompt: '系统提示' },
      limits: { turnTimeoutMs: 30 },
      discoverTools: async () => backend({ tools: [{ function: { name: 'api.call' } }],
        executeTool: async () => { calls++; await pending.promise; return { status: 'ok' }; } }),
      createModel: async () => ({ prompt: async input => {
        assert.deepEqual(parse(input).steering, ['已经交给模型']);
        if (mode === 'model-error') { await pending.promise; throw original; }
        return action(input, 'api.call', { method: 'POST' });
      } })
    });
    const running = client.run('开始');
    assert.equal(client.guide('已经交给模型').accepted, true); await tick();
    assert.equal(client.guide('尚未交给模型').accepted, true);
    if (mode === 'model-error') pending.resolve();
    await assert.rejects(running, error => {
      assert.equal(error.code, mode === 'model-error' ? 'HOST_MODEL_FAILED' : 'TURN_TIMEOUT');
      assert.deepEqual(error.pendingGuidance, ['尚未交给模型']);
      if (mode === 'model-error') assert.equal(error.cause, original);
      return true;
    });
    pending.resolve(); await tick(); assert.equal(calls, mode === 'model-error' ? 0 : 1);
    assert.equal(client.getState().busy, false); client.dispose();
  }
});

test('per-turn callbacks, IDs and external guidance stay within their run', async () => {
  const inputs = [], defaults = [], local = [], states = []; let external = ['补充条件'];
  const client = createAssistantSession({ profile: { systemPrompt: '系统提示' }, discoverTools: async () => backend(),
    createModel: async () => ({ prompt: async input => { inputs.push(parse(input)); return '回复'; } }),
    onText: value => defaults.push(value.text)
  });
  await client.run('开始', { turnId: 'page-1', onText: value => local.push(value.text), onState: value => states.push(value.state),
    takeGuidance: () => external.splice(0) });
  assert.equal(inputs[0].requestId, 'page-1:step-1');
  assert.deepEqual(inputs[0].steering, ['补充条件']);
  assert.deepEqual(local, ['回复']); assert.deepEqual(defaults, []);
  assert.equal(states.at(-1), 'completed');
  await client.run('下一轮');
  assert.deepEqual(defaults, ['回复']); assert.deepEqual(local, ['回复']);
  assert.notEqual(inputs[1].requestId, inputs[0].requestId);
  await assert.rejects(client.run('错误参数', null), /ASSISTANT_RUN_OPTIONS_INVALID/);
  await assert.rejects(client.run('错误回调', { onText: true }), /ASSISTANT_RUN_OPTIONS_INVALID/);
  assert.equal(client.getState().ready, true); assert.equal(client.getState().busy, false);
  client.dispose();
});

test('internal and external guidance queues drain separately without dropping accepted input', async () => {
  const pending = deferred(), inputs = []; let external = Array.from({ length: 16 }, (_, i) => '外部' + i);
  const client = createAssistantSession({ profile: { systemPrompt: '系统提示' }, discoverTools: async () => backend(),
    createModel: async () => { await pending.promise; return { prompt: async input => { inputs.push(parse(input)); return '回复'; } }; }
  });
  const running = client.run('开始', { takeGuidance: () => external.splice(0) });
  for (let i = 0; i < 16; i++) assert.equal(client.guide('内部' + i).accepted, true);
  assert.equal(client.guide('超出').accepted, false);
  pending.resolve(); await running;
  assert.equal(inputs[0].steering.length, 16); assert.equal(inputs[0].steering[0], '内部0');
  assert.equal(inputs[1].kind, 'steering'); assert.equal(inputs[1].text.length, 16); assert.equal(inputs[1].text[0], '外部0');
  client.dispose();
});
