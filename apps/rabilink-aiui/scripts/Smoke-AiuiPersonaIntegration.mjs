import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiToolRuntime } from '../utils/api-tool-runtime.js';
import { openApiToolLedger } from '../utils/api-tool-ledger.js';
import { createTaskFollowRuntime, TASK_FOLLOW_TOOL } from '../utils/task-follow-runtime.js';
import { sha256Text } from '../../../packages/rabi-api-contract/fingerprint.mjs';
import { formatApiResult } from '../utils/api-result-view.js';
import { createAgentTurnRuntime } from '../utils/agent-turn-runtime.js';
async function methods(name, exported, injected) {
  const code = (await fs.readFile(new URL('../utils/' + name, import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace('export const ' + exported, 'const ' + exported);
  return vm.runInNewContext(code + '\n' + exported, { openApiToolLedger, createTaskFollowRuntime, TASK_FOLLOW_TOOL, sha256Text, ...injected });
}

test('live degraded Manager permits available APIs; dead or unidentified generations cannot receive tools', async () => {
  for (const scenario of [
    { state: 'healthy', live: true, requiredReady: false, allowed: true },
    { state: 'degraded', live: true, requiredReady: false, allowed: true },
    { state: 'degraded', live: false, requiredReady: true, allowed: false },
    { state: 'starting', live: true, requiredReady: true, allowed: false },
    { state: 'healthy', live: true, requiredReady: true, missingIdentity: true, allowed: false }
  ]) {
    const stored = new Map(), calls = [];
    const meta = { applicationGenerationId: 'generation', managerInstanceId: scenario.missingIdentity ? '' : 'manager',
      health: { state: scenario.state, live: scenario.live, requiredReady: scenario.requiredReady } };
    const wx = { getStorageSync: key => stored.get(key), setStorageSync: (key, value) => stored.set(key, structuredClone(value)) };
    const apiMethods = await methods('api-tool-page.js', 'apiToolPageMethods', { wx, createApiToolRuntime, formatApiResult,
      requestDeviceApi: async (_config, packet) => {
        calls.push(packet);
        return { structuredContent: { ok: true, data: packet.request.path === '/meta' ? meta : { availableEndpoint: true } } };
      }
    });
    const page = { ...apiMethods, deviceAgentProfileConfig: () => ({ relayBaseUrl: 'https://relay.invalid', token: 'fixture', targetDeviceId: 'pc' }),
      agentProfileScope: () => 'scope', setKnowledgePageData() {}, speakText() {} };
    await page.prepareRabiApiTools();
    const result = page.handleRabiApiToolCall({ callId: 'check', functionName: 'rabi_api_call', isComplete: true,
      arguments: { method: 'GET', path: '/api/available-feature' } });
    if (scenario.allowed) {
      assert.equal((await result).result.structuredContent.data.availableEndpoint, true);
      assert.equal(calls[1].request.headers['x-rabiroute-expected-application-generation-id'], 'generation');
    } else await assert.rejects(result, /API_MANAGER_NOT_READY/);
    assert.equal(calls.length, scenario.allowed ? 2 : 1);
    page.cleanupRabiApiRuntime();
  }
});
test('model tools preserve the adopted persona PC and expose successful receipts to turn settlement', async () => {
  const stored = new Map(), packets = [];
  const meta = { applicationGenerationId: 'fixture-generation', managerInstanceId: 'fixture-instance', health: { live: true, requiredReady: true, state: 'healthy' } };
  const wx = { getStorageSync: key => stored.get(key), setStorageSync: (key, value) => stored.set(key, structuredClone(value)) };
  const apiMethods = await methods('api-tool-page.js', 'apiToolPageMethods', { wx, createApiToolRuntime, formatApiResult,
    requestDeviceApi: async (_config, packet) => { packets.push(packet); return { structuredContent: { ok: true, data: packet.request.path === '/meta' ? meta : { fixture: true } } }; }
  });
  const page = { ...apiMethods, deviceAgentProfile: { revision: 1, personaRef: {sourceDeviceId: 'pc-old'} }, config: () => ({ relayBaseUrl: 'https://relay.invalid', token: 'synthetic' }),
    deviceAgentProfileConfig: () => null, agentProfileScope: () => 'fixture-scope', setKnowledgePageData() {}, speakText() {} };
  await page.prepareRabiApiTools(); page.deviceAgentProfile = { revision: 2, personaRef: {sourceDeviceId: 'pc-new'} };
  let requests = 0;
  const model = { async prompt(input) {
    const packet = JSON.parse(input[0].content); requests++;
    if (requests === 1) return JSON.stringify({ protocol: 'rabi-agent/v1', requestId: packet.requestId, kind: 'tool', name: 'rabi_api_call', arguments: { method: 'POST', path: '/api/future', body: {} } });
    assert.equal(packet.observation.outcome.result.structuredContent.data.fixture, true); return '完成。';
  } };
  const turn = createAgentTurnRuntime({ model, tools: await page.rabiApiRuntime.loadTools(), executeTool: event => page.handleRabiApiToolCall(event) });
  const result = await turn.run('测试'); assert.notEqual(result.state, 'uncertain');
  assert.deepEqual(packets.map(packet => packet.targetDeviceId), ['pc-old', 'pc-old', 'pc-old']);
  assert.ok(packets.every(packet => !Object.hasOwn(packet, 'profileRevision')));
  assert.equal(packets[1].request.headers['x-rabiroute-expected-manager-instance-id'], 'fixture-instance');
});
test('user-first history sync cannot delete a reply added while its request is in flight', async () => {
  const stored = new Map(), submissions = [], pending = [];
  const wx = { getStorageSync: key => structuredClone(stored.get(key)), setStorageSync: (key, value) => stored.set(key, structuredClone(value)) };
  const history = await methods('aiui-conversation-page.js', 'aiuiConversationPageMethods', { wx,
    recordAiuiConversation: (_config, packet) => { submissions.push(packet); return new Promise(resolve => pending.push(resolve)); }
  });
  const profile = { revision: 1, personaRef: { roleId: 'Persona', sourceDeviceId: 'pc' } };
  const page = { ...history, deviceAgentProfile: profile, deviceAgentProfileScope: 'scope', deviceAgentProfileConfig: () => ({}), agentProfileScope: () => 'scope', setData() {} };
  const ticket = page.beginAiuiConversation('用户消息');
  page.finishAiuiConversation(ticket, '实际模型回复');
  pending[0]({ roleId: 'Persona', sourceDeviceId: 'pc' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(submissions.length, 2); assert.equal(submissions[1].assistantText, '实际模型回复');
  pending[1]({ roleId: 'Persona', sourceDeviceId: 'pc' }); await page.aiuiHistoryFlush;
  assert.equal(stored.get('rabilink-aiui-conversation-outbox-v1').rows.length, 0);
  // A previous owner process died after user-first sync: recovery preserves that user record and releases the pending slot.
  page.beginAiuiConversation('中断前用户消息'); pending[2]({ roleId: 'Persona', sourceDeviceId: 'pc' }); await page.aiuiHistoryFlush;
  page.recoverAiuiConversations(); pending[3]({ roleId: 'Persona', sourceDeviceId: 'pc' }); await page.aiuiHistoryFlush;
  assert.equal(stored.get('rabilink-aiui-conversation-outbox-v1').rows.length, 0);
});

test('obsolete tool discovery cannot replace a newer session or its persisted ledger', async () => {
  const stored = new Map(); let finishLookup, generation = 1;
  let config = { relayBaseUrl: 'https://relay.invalid', token: 'fixture', targetDeviceId: '' };
  const wx = { getStorageSync: key => stored.get(key), setStorageSync: (key, value) => stored.set(key, structuredClone(value)) };
  const apiMethods = await methods('api-tool-page.js', 'apiToolPageMethods', { wx, createApiToolRuntime, formatApiResult,
    getMobileState: () => new Promise(resolve => { finishLookup = resolve; }) });
  const page = { ...apiMethods, deviceAgentProfileConfig: () => config, agentProfileScope: () => 'scope', setKnowledgePageData() {}, speakText() {} };
  const old = page.prepareRabiApiTools({ isCurrent: () => generation === 1 });
  generation = 2; config = { ...config, targetDeviceId: 'pc-new' };
  const replacement = await page.prepareRabiApiTools({ isCurrent: () => generation === 2 });
  const ledger = structuredClone(stored.get('rabilink-aiui-api-ledger-v1'));
  finishLookup({ selectedTargetDeviceId: 'pc-old' });
  await assert.rejects(old, /VOICE_CONTEXT_CHANGED/);
  assert.equal(page.rabiApiRuntime, replacement.runtime);
  assert.deepEqual(stored.get('rabilink-aiui-api-ledger-v1'), ledger);
  page.cleanupRabiApiRuntime();
});

test('tool catalog completion after cancellation releases only its own candidate', async () => {
  let finishCatalog, releases = 0;
  const stored = new Map(), controller = new AbortController();
  const wx = { getStorageSync: key => stored.get(key), setStorageSync: (key, value) => stored.set(key, structuredClone(value)) };
  const candidate = { loadTools: () => new Promise(resolve => { finishCatalog = resolve; }), dispose() { releases++; } };
  const apiMethods = await methods('api-tool-page.js', 'apiToolPageMethods', { wx, createApiToolRuntime: () => candidate });
  const page = { ...apiMethods, deviceAgentProfileConfig: () => ({ relayBaseUrl: 'https://relay.invalid', token: 'fixture', targetDeviceId: 'pc' }), agentProfileScope: () => 'scope' };
  const pending = page.prepareRabiApiTools({ signal: controller.signal });
  const replacement = { dispose() { throw Error('replacement must survive'); } };
  controller.abort(); page.rabiApiRuntime = replacement; finishCatalog([]);
  await assert.rejects(pending, /VOICE_CONTEXT_CHANGED/);
  assert.equal(page.rabiApiRuntime, replacement); assert.equal(releases, 1);
});

async function recoveryFixture() {
  const stored = new Map(), packets = [];
  let activeScope = 'account-a', uncertain = true;
  const wx = { getStorageSync: key => structuredClone(stored.get(key)),
    setStorageSync: (key, value) => stored.set(key, structuredClone(value)) };
  const apiMethods = await methods('api-tool-page.js', 'apiToolPageMethods', { wx, createApiToolRuntime, formatApiResult,
    requestDeviceApi: async (_config, packet) => {
      packets.push(structuredClone(packet));
      return { structuredContent: packet.request.path === '/meta' ? { ok: true, data: {
        applicationGenerationId: 'generation', managerInstanceId: 'manager', health: { live: true, state: 'healthy' }
      } } : { ok: !uncertain, uncertain } };
    } });
  return { stored, packets, wx, scope(value) { activeScope = value; }, confirmed() { uncertain = false; },
    page() { return { ...apiMethods, deviceAgentProfileConfig: () => ({ relayBaseUrl: 'https://relay.invalid', token: activeScope, targetDeviceId: 'pc' }),
      agentProfileScope: config => config.token, setKnowledgePageData() {} }; } };
}
const recoveryCall = (callId, operationId, extra = {}) => ({ callId, functionName: 'rabi_api_call', isComplete: true,
  arguments: { method: 'PUT', path: '/api/future', operationId, body: { value: 'private-fixture' }, ...extra } });

test('model recreation and page reopen preserve original operations without replay or call-ID collision', async () => {
  const f = await recoveryFixture(); let p = f.page();
  await p.prepareRabiApiTools();
  await p.handleRabiApiToolCall(recoveryCall('call-1', 'original'));
  const before = f.packets.length;
  await p.prepareRabiApiTools();
  const restored = await p.handleRabiApiToolCall(recoveryCall('call-2', 'original'));
  assert.equal(restored.duplicate, true); assert.equal(restored.uncertain, true);
  assert.equal(f.packets.length, before);
  await assert.rejects(p.handleRabiApiToolCall(recoveryCall('call-3', 'original', { targetDeviceId: 'other-pc' })), /TOOL_OPERATION_TARGET_CONFLICT/);
  p.cleanupRabiApiRuntime(); p = f.page(); await p.prepareRabiApiTools(); f.confirmed();
  await p.handleRabiApiToolCall(recoveryCall('call-1', 'new-user-operation'));
  assert.equal(f.packets.filter(value => value.request.path === '/api/future').length, 2,
    'A new session may reuse its local call ID for an independently authorized operation.');
  assert.ok(!JSON.stringify([...f.stored.values()]).includes('private-fixture'));
  p.cleanupRabiApiRuntime();
});

test('switching connection scopes preserves each scope original operation receipts', async () => {
  const f = await recoveryFixture(), p = f.page();
  await p.prepareRabiApiTools(); await p.handleRabiApiToolCall(recoveryCall('one', 'same-id'));
  f.scope('account-b'); f.confirmed();
  await p.prepareRabiApiTools(); await p.handleRabiApiToolCall(recoveryCall('one', 'same-id'));
  const before = f.packets.length;
  f.scope('account-a'); await p.prepareRabiApiTools();
  assert.equal((await p.handleRabiApiToolCall(recoveryCall('two', 'same-id'))).uncertain, true);
  f.scope('account-b'); await p.prepareRabiApiTools();
  const completed = await p.handleRabiApiToolCall(recoveryCall('two', 'same-id'));
  assert.equal(completed.duplicate, true); assert.equal(completed.uncertain, false);
  assert.equal(f.packets.length, before); p.cleanupRabiApiRuntime();
});

test('a replaced page owner cannot dispatch or overwrite the new owner ledger', async () => {
  const f = await recoveryFixture(), old = f.page(), replacement = f.page();
  const original = await old.prepareRabiApiTools();
  await replacement.prepareRabiApiTools();
  await assert.rejects(original.runtime.handleToolCall(recoveryCall('old', 'old-operation')), /API_SCOPE_CHANGED/);
  assert.equal(f.packets.length, 0);
  await replacement.handleRabiApiToolCall(recoveryCall('new', 'new-operation'));
  old.cleanupRabiApiRuntime(); replacement.cleanupRabiApiRuntime();
});

test('legacy migration preserves original scope even when another connection opens first', async () => {
  const f = await recoveryFixture(); let rows;
  const legacy = createApiToolRuntime({ sessionId: 'aiui-7', defaultTargetDeviceId: 'pc',
    storage: { load: () => rows || [], save: value => { rows = structuredClone(value); } },
    call: async () => ({ structuredContent: { ok: false, uncertain: true } }) });
  await legacy.handleToolCall(recoveryCall('old-call', 'old-operation'));
  f.stored.set('rabilink-aiui-api-ledger-v1', { counter: 7, scope: 'account-a', rows: rows.map(({ sessionId, ...row }) => row) });
  f.scope('account-b'); let p = f.page(); await p.prepareRabiApiTools();
  p.cleanupRabiApiRuntime(); f.scope('account-a'); p = f.page(); await p.prepareRabiApiTools();
  const result = await p.handleRabiApiToolCall(recoveryCall('new-call', 'old-operation'));
  assert.equal(result.duplicate, true); assert.equal(result.uncertain, true);
  assert.equal(f.packets.length, 0);
  assert.ok(f.stored.get('rabilink-aiui-api-ledger-v1').counter > 7);
  p.cleanupRabiApiRuntime();
});

test('unconfirmed or failed write-ahead storage never dispatches an operation', async () => {
  for (const fault of ['throw', 'no-op', 'unreadable']) {
    const f = await recoveryFixture(), p = f.page(); await p.prepareRabiApiTools();
    const write = f.wx.setStorageSync;
    f.wx.setStorageSync = (key, value) => {
      if (value.rows?.some(row => row.state === 'pending')) {
        if (fault === 'throw') throw Error('storage fixture failure');
        if (fault === 'unreadable') write(key, { ...value, rows: [] });
        return;
      }
      write(key, value);
    };
    await assert.rejects(p.handleRabiApiToolCall(recoveryCall('one', 'write-failure')), /storage fixture failure|API_LEDGER_SAVE_UNCONFIRMED/);
    assert.equal(f.packets.length, 0, fault);
    p.cleanupRabiApiRuntime();
  }
});

test('interrupted migration retains original rows and can resume without overwriting them', async () => {
  const f = await recoveryFixture(), original = { counter: 7, scope: 'account-a', rows: [
    { id: 'legacy', operationId: 'original', fingerprint: 'a'.repeat(64), state: 'pending' }
  ] };
  f.stored.set('rabilink-aiui-api-ledger-v1', original);
  const write = f.wx.setStorageSync;
  f.wx.setStorageSync = (key, value) => {
    if (key === 'rabilink-aiui-api-ledger-v1') throw Error('allocator fixture failure');
    write(key, value);
  };
  assert.throws(() => openApiToolLedger({ storage: f.wx, scope: 'account-b' }), /allocator fixture failure/);
  assert.deepEqual(f.stored.get('rabilink-aiui-api-ledger-v1'), original);
  f.wx.setStorageSync = write;
  openApiToolLedger({ storage: f.wx, scope: 'account-b' });
  const restored = openApiToolLedger({ storage: f.wx, scope: 'account-a' });
  assert.equal(restored.storage.load()[0].operationId, 'original');
  assert.equal(restored.storage.load()[0].state, 'pending');
  assert.equal(f.packets.length, 0);
});

test('full write history preserves read-only receipt access and rejects new mutations', async () => {
  const f = await recoveryFixture(), ledger = openApiToolLedger({ storage: f.wx, scope: 'account-a' });
  ledger.storage.save(Array.from({ length: 128 }, (_, index) => ({ id: 'call-' + index, sessionId: ledger.sessionId,
    operationId: 'operation-' + index, fingerprint: 'a'.repeat(64), state: index % 2 ? 'completed' : 'pending' })));
  const p = f.page(); await p.prepareRabiApiTools();
  await assert.rejects(p.handleRabiApiToolCall(recoveryCall('new-call', 'new-operation')), /TOOL_LEDGER_FULL/);
  assert.equal(f.packets.length, 0);
  await p.handleRabiApiToolCall({ callId: 'receipt-read', functionName: 'rabi_api_call', isComplete: true,
    arguments: { method: 'GET', path: '/api/original-receipt' } });
  assert.deepEqual(f.packets.map(value => value.request.path), ['/meta', '/api/original-receipt']);
  p.cleanupRabiApiRuntime();
  const recovered = openApiToolLedger({ storage: f.wx, scope: 'account-a' });
  assert.equal(recovered.storage.load().length, 128, 'Recreation retires read slots, never write evidence.');
});

test('disposing a tool runtime during Manager identity lookup prevents later mutation dispatch', async () => {
  const f = await recoveryFixture(); let finishMeta;
  const apiMethods = await methods('api-tool-page.js', 'apiToolPageMethods', { wx: f.wx, createApiToolRuntime, formatApiResult,
    requestDeviceApi: async (_config, packet) => {
      f.packets.push(packet);
      assert.equal(packet.request.path, '/meta', 'A released runtime must not submit the mutation.');
      return new Promise(resolve => { finishMeta = () => resolve({ structuredContent: { ok: true, data: {
        applicationGenerationId: 'generation', managerInstanceId: 'manager', health: { live: true, state: 'healthy' }
      } } }); });
    } });
  const p = { ...f.page(), ...apiMethods }; await p.prepareRabiApiTools();
  const pending = p.handleRabiApiToolCall(recoveryCall('one', 'original'));
  const rejection = assert.rejects(pending, /API_SCOPE_CHANGED/);
  await new Promise(resolve => setImmediate(resolve));
  p.cleanupRabiApiRuntime(); finishMeta(); await rejection;
  assert.equal(f.packets.length, 1);
});

test('malformed legacy data is preserved and cannot reset the operation allocator', async () => {
  const f = await recoveryFixture();
  for (const original of [{ counter: -1, scope: 'account-a', rows: [] },
    { counter: 7, scope: 'account-a', rows: [{ id: 'one', state: 'completed', fingerprint: 'not-a-digest' }] }]) {
    f.stored.set('rabilink-aiui-api-ledger-v1', original);
    assert.throws(() => openApiToolLedger({ storage: f.wx, scope: 'account-a' }), /API_LEDGER_INVALID|TOOL_LEDGER_INVALID/);
    assert.deepEqual(f.stored.get('rabilink-aiui-api-ledger-v1'), original);
  }
  assert.equal(f.packets.length, 0);
});
