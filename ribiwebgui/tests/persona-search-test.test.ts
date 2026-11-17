import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import type { GatewayDefinition } from '../../src/shared/gatewayConfigModel';
import type { WebRendererContribution } from '../src/pluginRenderers';
import { remoteAgentTargetKey } from '../../src/shared/routeAgentTargets';
import { searchTestIdentities, runSearchTest, parseSearchTestParameters, searchTestResultGroups, searchTestHighlights } from '../../src/plugins/io.rabiroute.manager.persona/web/persona/searchTestClient';

const route = { id: 'route', name: 'Route', agentRoleId: 'Role', agentAdapters: ['dsh'], primaryAgentAdapter: 'dsh' } as GatewayDefinition;
const renderers = [{ agentType: 'dsh', agentRoute: { session: () => ({ sessionId: 'real-session-id', sessionName: 'Session', workspace: 'workspace' }) } }] as WebRendererContribution[];

test('search identities use the configured primary provider and full original session', () => {
  const result = searchTestIdentities('Role', [route, { ...route, id: 'other', agentRoleId: 'Other' }], renderers);
  assert.deepEqual(result.identities.map(x => [x.agentType, x.sessionId]), [['role', 'Role'], ['dsh', 'real-session-id']]);
  const unavailable = searchTestIdentities('Role', [route], []);
  assert.equal(unavailable.identities[1].sessionId, '');
});

test('remote primary identities keep their saved session and malformed routes remain local failures', () => {
  const binding = { instanceId: 'instance', agentId: 'agent', ownerDeviceId: 'peer' };
  const id = remoteAgentTargetKey(binding);
  const remote = { ...route, primaryAgentTarget: id, remoteAgentTargets: [{ ...binding, id, provider: 'dsh', sessionId: 'remote-session' }] };
  const bad = { ...route, id: 'bad', remoteAgentTargets: [{ ...binding, id: 'invalid', provider: 'dsh' }] };
  const result = searchTestIdentities('Role', [bad, remote], renderers);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.identities[1].sessionId, 'remote-session');
});

test('the real unified entry receives explicit caller headers and query parameters, including error responses', async () => {
  const controller = new AbortController();
  const body = { code: -1, requestId: 'request-id', message: 'Invalid limit' };
  const receipt = await runSearchTest(async (input, init) => {
    const url = new URL(String(input), 'http://fixture');
    assert.equal(url.pathname, '/api/search');
    assert.equal(url.searchParams.get('q'), '中文 search');
    assert.equal(url.searchParams.get('scope'), 'messages,knowledge');
    assert.equal(url.searchParams.get('limit'), 'invalid');
    assert.deepEqual(init?.headers, { accept: 'application/json', 'x-rabiroute-agent-type': 'dsh', 'x-rabiroute-session-id': 'full-id' });
    assert.equal(init?.signal, controller.signal);
    return Response.json(body, { status: 400 });
  }, JSON.stringify({ q: '中文 search', scope: ['messages', 'knowledge'], limit: 'invalid' }), { agentType: 'dsh', sessionId: 'full-id' }, controller.signal);
  assert.equal(receipt.status, 400);
  assert.deepEqual(receipt.body, body);
});

test('invalid JSON never sends a request and message history places the test before Refresh channels', async () => {
  await assert.rejects(runSearchTest(async () => assert.fail('Unexpected request'), '[]', { agentType: 'role', sessionId: 'Role' }, new AbortController().signal), /JSON/);
  const source = fs.readFileSync(new URL('../../src/plugins/io.rabiroute.manager.persona/web/components/PersonaMessageHistory.vue', import.meta.url), 'utf8');
  assert.ok(source.indexOf("t('搜索接口测试')") < source.indexOf("t('刷新渠道')"));
});

test('JSON editing preserves additional query fields and rejects non-object parameters', () => {
  const input = { q: '角色', agent: 'Role', limit: 20, from: 123, adapter: 'napcat', includeArchives: 1 };
  assert.deepEqual(parseSearchTestParameters(JSON.stringify(input)), input);
  for (const value of ['null', '[]', '"text"', '{']) assert.throws(() => parseSearchTestParameters(value));
});

test('repeated message presentation preserves every record and separates conversation or type changes', () => {
  const item = { source: 'messages', kind: 'message', label: 'Repeated title', excerpt: 'Content', agent: 'Role', origin: { conversationKey: 'chat1' } };
  const records = [item, { ...item, excerpt: 'Different original content' }, { ...item, origin: { conversationKey: 'chat2' } }, { ...item, source: 'knowledge' }, item];
  const groups = searchTestResultGroups(records);
  assert.deepEqual(groups.map(group => group.indexes), [[0, 1], [2], [3], [4]]);
  assert.deepEqual(groups.flatMap(group => group.indexes), records.map((_, index) => index));
});

test('search highlighting treats metacharacters and markup as literal text', () => {
  assert.deepEqual(searchTestHighlights('角色 A+B <img>', '角色 A+B <img>').filter(part => part.matched).map(part => part.text), ['角色', 'A+B', '<img>']);
  assert.deepEqual(searchTestHighlights('Same same', 'same').filter(part => part.matched).map(part => part.text), ['Same', 'same']);
  assert.deepEqual(searchTestHighlights('Anything', ''), [{ text: 'Anything', matched: false }]);
});
