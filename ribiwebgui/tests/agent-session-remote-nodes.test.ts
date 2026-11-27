import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentSessionClient, type AgentNode } from '../../src/plugins/io.rabiroute.manager.persona/web/persona/agentSessionClient';

type Call = { url: string; body: any };
const json = (value: unknown, status = 200) => Response.json(value, { status });

/**
 * The computer directory is the single source of devices. `kind` is the directory's own
 * distinction: `host` computers own Agents directly, `node` computers were enrolled as
 * LAN nodes and read their own Agent through an instance binding.
 */
const directory = { code: 0, data: { computers: [
  { id: 'local-instance', instanceId: 'local-instance', kind: 'host', local: true, name: '公司开发机', hostname: '公司开发机',
    platform: 'win32', status: 'online', agents: [{ agentId: 'local:codex', name: 'Local Codex', provider: 'codex-desktop' }] },
  { id: 'local-instance/ceshiji1', instanceId: 'ceshiji1', kind: 'node', local: false, name: '测试机1｜1.1开发', hostname: '测试机1',
    platform: 'win32-x64', status: 'online', agents: [{ agentId: 'abc-123', name: 'Codex', provider: 'codex-desktop' }] },
  { id: 'local-instance/codex-mac', instanceId: 'codex-mac', kind: 'node', local: false, name: '打包机Mac', hostname: 'mac',
    platform: 'darwin-arm64', status: 'online', agents: [{ agentId: 'default', name: 'Codex', provider: 'codex-desktop' }] },
  { id: 'peer:elysia-instance', instanceId: 'elysia-instance', kind: 'host', local: false, ownerDeviceId: 'elysia', name: 'Elysia',
    hostname: 'Elysia', platform: 'win32', status: 'online', agents: [
      { agentId: '夜雨:codex', name: 'Night', provider: 'codex-desktop' }, { agentId: '夜雨:dsh', name: 'Night DSH', provider: 'dsh' }] },
  { id: 'peer:unknown-host', instanceId: '', kind: 'host', local: false, ownerDeviceId: 'unknown-host', name: 'Yeyu',
    platform: 'win32', status: 'unknown', agents: [] },
  { id: 'peer:offline-host', instanceId: '', kind: 'host', local: false, ownerDeviceId: 'offline-host', name: '星海建造师的电脑', status: 'offline', agents: [] }
], sourceErrors: [] } };

function fixture(sessions: Record<string, unknown[]> = { codex: [{ id: 'a', title: 'A' }], dsh: [] }) {
  const calls: Call[] = [];
  const request = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url === '/api/computers') return json(directory);
    const provider = url.includes('/providers/codex/') ? 'codex' : url.includes('/providers/dsh/') ? 'dsh' : '';
    if (provider) {
      if (url.includes('/history?')) return json({ code: 0, data: { entries: [], nextCursor: null } });
      const items = sessions[provider] ?? [];
      return json({ code: 0, data: { items, nextOffset: items.length ? items.length : null } });
    }
    return json({ code: 0, threads: body?.instanceBinding ? [{ id: 'bound', title: 'Bound thread' }] : [], nextOffset: null });
  }) as typeof fetch;
  return { request, calls };
}

test('the device list comes from the computer directory and matches Device control', async () => {
  const { request } = fixture();
  const nodes = await createAgentSessionClient(request).nodes();
  assert.deepEqual(nodes.map(node => [node.id, node.kind, node.status]), [
    ['local', 'local', 'online'],
    ['node:ceshiji1', 'instance', 'online'],
    ['node:codex-mac', 'instance', 'online'],
    ['peer:elysia', 'peer', 'online'],
    ['peer:unknown-host', 'peer', 'unknown'],
    ['peer:offline-host', 'peer', 'offline']
  ]);
  assert.equal(nodes[0].name, '公司开发机');
  // Platform is carried through so the view can use the shared operating-system icon rule.
  assert.equal(nodes[2].platform, 'darwin-arm64');
  assert.equal(nodes[1].agents?.[0].agentId, 'abc-123');
});

test('a directory node reads its own Agent through an instance binding on this Manager', async () => {
  const { request, calls } = fixture();
  const node: AgentNode = { id: 'node:ceshiji1', kind: 'instance', name: '测试机1', online: true, status: 'online',
    instanceId: 'ceshiji1', platform: 'win32-x64', agents: [{ agentId: 'abc-123', name: 'Codex', provider: 'codex-desktop' }] };
  const client = createAgentSessionClient(request, '', { node: () => node });
  const agents = await client.agents('unused-role');
  assert.equal(agents.length, 1);
  assert.deepEqual(agents[0].binding, { instanceId: 'ceshiji1', agentId: 'abc-123' });
  await client.tasks(agents[0], '');
  const list = calls.at(-1)!;
  assert.equal(list.url, '/api/agent/threads');
  assert.deepEqual(list.body.instanceBinding, { instanceId: 'ceshiji1', agentId: 'abc-123' });
  assert.equal(list.body.action, 'list');
});

test('a relay host reads its own Agent endpoints through that computer prefix', async () => {
  const { request, calls } = fixture();
  const node: AgentNode = { id: 'peer:elysia', kind: 'peer', name: 'Elysia', online: true, status: 'online',
    deviceId: 'elysia', agents: [{ agentId: '夜雨:codex', name: 'Night', provider: 'codex-desktop' }] };
  const client = createAgentSessionClient(request, '', { node: () => node });
  const agents = await client.agents('unused-role');
  assert.equal(agents.length, 1);
  const prefix = '/api/rabilink/peer/http/elysia/manager';
  await client.tasks(agents[0], 'q', 10);
  assert.ok(calls.at(-1)!.url.startsWith(prefix), 'reads stay on the owning computer');
  assert.equal(new URL(calls.at(-1)!.url, 'http://x').searchParams.get('query'), 'q');
  await client.history(agents[0], 'task/one', 'cursor-1');
  const history = calls.at(-1)!;
  assert.ok(history.url.startsWith(prefix));
  assert.equal(new URL(history.url, 'http://x').searchParams.get('cursor'), 'cursor-1');
});

test('an offline directory entry never reads and keeps its own status', async () => {
  const { request, calls } = fixture();
  const node: AgentNode = { id: 'peer:offline-host', kind: 'peer', name: '星海建造师的电脑', online: false, status: 'offline', agents: [] };
  const client = createAgentSessionClient(request, '', { node: () => node });
  const agents = await client.agents('unused-role');
  assert.equal(agents.length, 0);
  assert.equal(calls.filter(call => call.url.includes('peer/http')).length, 0);
});
