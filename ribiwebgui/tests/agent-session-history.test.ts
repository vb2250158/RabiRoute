import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { agentHistoryEvents, agentHistoryMessages, agentHistoryNextCursor } from '../../src/plugins/io.rabiroute.manager.persona/web/persona/agentSessionHistory';
import { createAgentSessionClient, personaSessionAgents } from '../../src/plugins/io.rabiroute.manager.persona/web/persona/agentSessionClient';
import type { GatewayDefinition } from '../../src/shared/gatewayConfigModel';
import { remoteAgentTargetKey } from '../../src/shared/routeAgentTargets';

const native = (sequence: number, type: string, payload: Record<string, unknown>) => ({ sequence, record: { type, payload } });
const dsh = (seq: number, type: string, data: Record<string, unknown>) => ({ type: 'event', event: { seq, type, data } });

test('configured Agents switch through second-level tabs bound to the selected endpoint', () => {
  const source = fs.readFileSync(new URL('../../src/plugins/io.rabiroute.manager.persona/web/components/PersonaAgentSessions.vue', import.meta.url), 'utf8');
  assert.match(source, /<v-tabs v-model="agentKey"[^>]*:aria-label="t\('Agent 端'\)"/);
  assert.match(source, /<v-tab v-for="item in agents"[^>]*:value="item.key"/);
  assert.doesNotMatch(source, /<v-select\b/);
});

test('Codex history shows user input and final replies, filters tools/reasoning/commentary, deduplicates native streams across pages', () => {
  const first = agentHistoryEvents('codex', { entries: [
    native(1, 'event_msg', { type: 'user_message', message: 'Question' }),
    null,
    native(2, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Question' }] }),
    native(3, 'response_item', { type: 'reasoning', summary: [{ text: 'private reasoning' }] }),
    native(4, 'response_item', { type: 'function_call', arguments: 'private tool input' }),
    native(5, 'response_item', { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Working' }] }),
    native(6, 'response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Answer' }] })
  ] });
  const second = agentHistoryEvents('codex', { entries: [
    native(7, 'event_msg', { type: 'task_complete', last_agent_message: 'Answer' }),
    native(8, 'event_msg', { type: 'user_message', message: 'Question' }),
    native(9, 'event_msg', { type: 'user_message', message: 'Question' })
  ] });
  assert.deepEqual(agentHistoryMessages('codex', [...first, ...second]).map(item => [item.role, item.text]), [
    ['user', 'Question'], ['assistant', 'Answer'], ['user', 'Question'], ['user', 'Question']
  ]);
  assert.equal(agentHistoryNextCursor('codex', { nextCursor: 'native-cursor', entries: [] }), 'native-cursor');
});

test('DSH history chooses the last assistant message of completed turns and keeps backwards page boundaries', () => {
  const newer = { hasMore: true, cursor: 99, records: [
    dsh(5, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Final reply' }, { type: 'reasoning', text: 'hidden' }] } }),
    dsh(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    dsh(8, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'In progress' }] } })
  ] };
  const older = { records: [
    dsh(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Question' }] }),
    dsh(2, 'user/message', { source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Injected context' }] }),
    dsh(3, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Intermediate text' }] } }),
    dsh(4, 'tool/result', { text: 'hidden tool result' })
  ] };
  assert.equal(agentHistoryNextCursor('dsh', newer), '5', 'beforeSeq uses first returned event, not the throughSeq watermark');
  assert.deepEqual(agentHistoryMessages('dsh', [...agentHistoryEvents('dsh', newer), ...agentHistoryEvents('dsh', older)])
    .map(item => [item.role, item.text]), [['user', 'Question'], ['assistant', 'Final reply']]);
  assert.throws(() => agentHistoryNextCursor('dsh', { hasMore: true, records: [] }), /下一页/);
});

test('configured role Agents retain separate remote identities, DSH origins and unavailable providers', () => {
  const binding = { instanceId: 'pc-two', agentId: 'codex', ownerDeviceId: 'owner-pc' };
  const routes = [
    { id: 'one', agentRoleId: 'Example', agentAdapters: ['codex', 'dsh', 'missing-plugin'], dshBaseUrl: 'http://localhost:3000',
      remoteAgentTargets: [{ ...binding, id: remoteAgentTargetKey(binding), provider: 'codex' }] },
    { id: 'two', agentRoleId: 'Example', agentAdapters: ['codex', 'dsh'], dshBaseUrl: 'http://localhost:3001' },
    { id: 'other', agentRoleId: 'Other', agentAdapters: ['other-provider'] },
    { id: 'foreign', agentRoleId: 'Example', agentRoleDeviceId: 'foreign-owner', agentAdapters: ['foreign-provider'] }
  ] as GatewayDefinition[];
  const agents = personaSessionAgents(routes, 'Example');
  assert.equal(agents.length, 5);
  assert.deepEqual(agents.find(agent => agent.id === 'local:codex')?.routes, ['one', 'two']);
  assert.deepEqual(agents.find(agent => agent.binding)?.binding, binding);
  assert.equal(agents.filter(agent => agent.provider === 'dsh').length, 2);
  assert(agents.some(agent => agent.provider === 'missing-plugin'));
});

test('task and history reads keep the original remote owner and cursor, and propagate cancellation', async () => {
  const calls: Array<{ url: string; body: any; signal?: AbortSignal | null }> = [];
  const binding = { instanceId: 'pc-two', agentId: 'codex', ownerDeviceId: 'owner-pc' };
  const agent = { key: 'target', id: remoteAgentTargetKey(binding), provider: 'codex', binding, routes: [] };
  const request = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal });
    if (!init?.body) return Response.json({ code: 0, data: { entries: [], nextCursor: 'following' } });
    return Response.json({ code: 0, threads: [{ id: 'opaque-task', title: 'Task' }], nextOffset: 50,
      history: { entries: [], nextCursor: 'following' } });
  }) as typeof fetch;
  const client = createAgentSessionClient(request), signal = new AbortController().signal;
  assert.equal((await client.tasks(agent, 'query', 0, signal)).nextOffset, 50);
  await client.history(agent, 'opaque-task', 'original-cursor', signal);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.instanceBinding, binding);
  const historyUrl = new URL(calls[1].url, 'http://localhost');
  assert.equal(historyUrl.pathname, '/api/rabilink/peer/http/owner-pc/manager/api/agent/providers/codex/sessions/opaque-task/history');
  assert.equal(historyUrl.searchParams.get('cursor'), 'original-cursor');
  assert.equal(historyUrl.searchParams.get('maxBytes'), '2097152');
  assert.equal(calls[1].body, undefined);
  assert.equal(calls[1].signal, signal);
});


test('installed metadata-only thread reader does not prevent native Codex and DSH history reads', async () => {
  const urls: string[] = [];
  const client = createAgentSessionClient((async (url: string, init?: RequestInit) => {
    urls.push(url);
    assert.equal(init?.body, undefined, 'use the published native history API, not an optional flag ignored by older hosts');
    return Response.json({ code: 0, data: url.includes('/codex/')
      ? { entries: [native(1, 'event_msg', { type: 'user_message', message: 'Question' })], nextCursor: null }
      : { records: [dsh(1, 'user/message', { source: { kind: 'user' }, content: 'Question' })], hasMore: false } });
  }) as typeof fetch);
  for (const provider of ['codex', 'dsh']) {
    const page = await client.history({ id: `local:${provider}`, provider, key: provider, routes: [] }, 'task/one', provider === 'dsh' ? '20' : undefined);
    assert.equal(agentHistoryMessages(provider, agentHistoryEvents(provider, page))[0].text, 'Question');
  }
  assert(urls[0].includes('/sessions/task%2Fone/history?'));
  assert.equal(new URL(urls[1], 'http://localhost').searchParams.get('beforeSeq'), '20');
});

test('explicit DSH origin and enrolled LAN instance keep their original instance-scoped history operation', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const client = createAgentSessionClient((async (url: string, init?: RequestInit) => {
    if (url === '/api/webgui-access') return Response.json({ code: 0, data: { token: 'fixture-token' } });
    const body = JSON.parse(String(init?.body)); calls.push({ url, body });
    return Response.json(url.includes('/lan-agent/') ? { code: 0, result: { data: { history: { entries: [] } } } } : { code: 0, history: { records: [] } });
  }) as typeof fetch);
  await client.history({ id: 'local:dsh', provider: 'dsh', key: 'dsh', routes: [], dshBaseUrl: 'http://localhost:3001' }, 'dsh-task', '12');
  assert.equal(calls[0].body.dshBaseUrl, 'http://localhost:3001');
  assert.deepEqual(calls[0].body.history, { limit: 200, cursor: '12' });
  const binding = { instanceId: 'lan', agentId: 'codex' };
  await client.history({ id: remoteAgentTargetKey(binding), provider: 'codex', key: 'lan', routes: [], binding }, 'lan-task');
  assert(calls[1].url.includes('/instances/lan/agents/codex/threads'));
});


test('the role history grid keeps its implicit minimum within the viewport for long Agent tabs and messages', () => {
  const source = fs.readFileSync(new URL('../../src/plugins/io.rabiroute.manager.persona/web/pages/RoleMessageHistoryPage.vue', import.meta.url), 'utf8');
  assert.match(source, /\.page-shell\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});
