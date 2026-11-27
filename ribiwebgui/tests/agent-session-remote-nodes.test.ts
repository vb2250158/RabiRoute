import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentSessionClient, type AgentNode } from '../../src/plugins/io.rabiroute.manager.persona/web/persona/agentSessionClient';

type Call = { url: string; body: any };
const json = (value: unknown, status = 200) => Response.json(value, { status });

function fixture(overrides: { peers?: unknown[]; instances?: unknown[]; sessions?: Record<string, unknown[]> } = {}) {
  const calls: Call[] = [];
  const sessions = overrides.sessions ?? { codex: [{ id: 'codex-root', title: 'Codex root' }], dsh: [{ id: 'dsh-root', title: 'DSH root' }] };
  const request = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url === '/api/rabilink/peer/servers') return json({ selectedDeviceId: '', peers: overrides.peers ?? [
      { deviceId: 'elysia', name: 'Elysia', online: true, state: 'idle', latencyMs: 1180 },
      { deviceId: 'offline-pc', name: 'Offline PC', online: false, state: 'offline' }
    ] });
    if (url.endsWith('/api/lan-agent/instances')) return json({ code: 0, instances: overrides.instances ?? [
      { instanceId: 'remote-instance', local: true, connected: true, name: 'Remote instance', hostname: 'remote-host',
        agents: [{ agentId: 'remote:codex', name: 'Remote Codex', provider: 'codex-desktop', enabled: true },
          { agentId: 'remote:dsh', name: 'Remote DSH', provider: 'dsh', enabled: false },
          { agentId: '中文路由:codex', name: 'Non-ASCII route', provider: 'codex-desktop', enabled: true }] }
    ] });
    if (url.includes('/api/agent-adapters/catalog')) return json({ code: 0, data: { adapters: [] } });
    const provider = url.includes('/providers/codex/') ? 'codex' : url.includes('/providers/dsh/') ? 'dsh' : '';
    if (provider) {
      const items = sessions[provider] ?? [];
      if (url.includes('/history?')) return json({ code: 0, data: { entries: [], nextCursor: null } });
      return json({ code: 0, data: { items, nextOffset: items.length ? items.length : null } });
    }
    return json({ code: 0, threads: body?.agentAdapter === 'grokBot' ? [{ id: 'grok-root', title: 'Grok root' }] : [], nextOffset: null });
  }) as typeof fetch;
  return { request, calls };
}

test('nodes combine this Manager, RabiLink computers and enrolled LAN Agent instances', async () => {
  const { request } = fixture();
  const client = createAgentSessionClient(request);
  const nodes = await client.nodes();
  assert.deepEqual(nodes.map(node => [node.id, node.kind, node.online]), [
    ['local', 'local', true],
    ['peer:elysia', 'peer', true],
    ['peer:offline-pc', 'peer', false],
    ['instance:elysia:remote-instance', 'instance', true]
  ]);
  assert.deepEqual(nodes[3].agents?.map(agent => [agent.agentId, agent.provider]), [
    ['remote:codex', 'codex-desktop'], ['remote:dsh', 'dsh']
  ]);
});

test('local Agent tabs are discovered by sessions, not by the selected role route', async () => {
  const { request, calls } = fixture({ sessions: { codex: [{ id: 'c', title: 'C' }], dsh: [] } });
  const client = createAgentSessionClient(request, '', { node: () => ({ id: 'local', kind: 'local', name: '本机', online: true }), candidates: () => ['codex', 'dsh'] });
  const agents = await client.agents('any-role');
  assert.deepEqual(agents.map(agent => agent.provider), ['codex']);
  assert.equal(agents[0].nodeKind, 'local');
  assert.equal(calls.some(call => call.url === '/gateways?summary=1&includeConfig=1'), false);
  assert(calls.some(call => call.url.includes('/api/agent/providers/codex/sessions')));
});

test('peer tabs and reads always use that computer prefix while preserving the exact session id', async () => {
  const { request, calls } = fixture();
  let node: AgentNode | undefined = { id: 'peer:elysia', kind: 'peer', name: 'Elysia', online: true, deviceId: 'elysia' };
  const client = createAgentSessionClient(request, '', { node: () => node, candidates: () => ['codex', 'dsh'] });
  const agents = await client.agents('unused-role');
  assert.deepEqual(agents.map(agent => agent.provider), ['codex', 'dsh']);
  const codex = agents[0];
  const prefix = '/api/rabilink/peer/http/elysia/manager';
  assert(calls.every(call => call.url.startsWith(prefix)), 'probes never fall back to the local Manager');
  await client.tasks(codex, 'query', 10);
  await client.history(codex, 'task/one', 'cursor-1');
  const list = calls.find(call => call.url.includes('/sessions?') && call.url.includes('offset=10'))!;
  const history = calls.find(call => call.url.includes('/sessions/task%2Fone/history'))!;
  assert(list.url.startsWith(prefix));
  assert(history.url.startsWith(prefix));
  assert.equal(new URL(history.url, 'http://local').searchParams.get('cursor'), 'cursor-1');
});

test('instance tabs bind the exact instance and agent and keep the instance-scoped read', async () => {
  const { request, calls } = fixture();
  const node: AgentNode = { id: 'instance:elysia:remote-instance', kind: 'instance', name: 'Remote instance', online: true,
    instanceId: 'remote-instance', deviceId: 'elysia',
    agents: [{ agentId: 'remote:codex', name: 'Remote Codex', provider: 'codex-desktop', enabled: true }] };
  const client = createAgentSessionClient(request, '', { node: () => node });
  const agents = await client.agents('unused-role');
  assert.deepEqual(agents.map(agent => [agent.provider, agent.label, agent.binding]), [
    ['codex', 'Remote Codex', { instanceId: 'remote-instance', agentId: 'remote:codex' }]
  ]);
  await client.tasks(agents[0], '');
  assert.equal(calls.at(-1)!.body.action, 'list');
  assert.deepEqual(calls.at(-1)!.body.instanceBinding, { instanceId: 'remote-instance', agentId: 'remote:codex' });
  assert.equal(calls.at(-1)!.url, '/api/rabilink/peer/http/elysia/manager/api/agent/threads');
});

test('local providers use the shared thread list while instance providers name their exact agent', async () => {
  const { request, calls } = fixture({ sessions: { codex: [], dsh: [] } });
  const client = createAgentSessionClient(request, '', { node: () => ({ id: 'local', kind: 'local', name: '本机', online: true }), candidates: () => ['codex', 'dsh', 'grokBot'] });
  const agents = await client.agents('unused-role');
  assert.deepEqual(agents.map(agent => agent.provider), ['grokBot']);
  const list = calls.find(call => call.body?.action === 'list')!;
  assert.equal(list.url, '/api/agent/threads');
  assert.equal(list.body.agentAdapter, 'grokBot');
  assert.equal(list.body.agentTargetId, 'local:grokBot');
});
