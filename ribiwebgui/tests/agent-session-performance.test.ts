import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createAgentSessionClient, remoteAgentProviders, SESSION_PAGE_SIZE, PROBE_TIMEOUT_MS } from '../../src/plugins/io.rabiroute.manager.persona/web/persona/agentSessionClient';

/** A fetch double that records every URL and body the session client issues. */
function recorder(handler: (url: string, body: any) => { ok?: boolean; payload: unknown }) {
  const calls: Array<{ url: string; body: any }> = [];
  const request = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const result = handler(url, body);
    return Response.json(result.payload, { status: result.ok === false ? 500 : 200 });
  }) as typeof fetch;
  return { request, calls };
}

const directory = (computers: unknown[]) => ({ code: 0, data: { computers } });

test('the listing never asks the owner to scan previews', async () => {
  // `previews=1` used to make a remote PC scan every transcript: 17s for one page.
  const { request, calls } = recorder(() => ({ payload: { code: 0, data: { items: [], nextOffset: null } } }));
  const client = createAgentSessionClient(request, '', { node: () => ({ id: 'peer:x', kind: 'peer', name: 'X', online: true, deviceId: 'x' }) });
  await client.agents('role');
  await client.tasks({ id: 'p', key: 'codex', provider: 'codex', routes: [], nodeKind: 'peer' }, '', 0);
  assert.equal(calls.some(call => call.url.includes('previews=1')), false, 'no listing request may carry previews');
  assert.equal(SESSION_PAGE_SIZE < 50, true, 'a first page stays smaller than the old 50-row default');
});

test('a provider probe is bounded and asks for a single row', async () => {
  assert.equal(PROBE_TIMEOUT_MS > 0 && PROBE_TIMEOUT_MS <= 10000, true);
  const { request, calls } = recorder(() => ({ payload: { code: 0, data: { items: [{ id: 'a' }], nextOffset: null } } }));
  const client = createAgentSessionClient(request, '', { node: () => ({ id: 'local', kind: 'local', name: '本机', online: true }) });
  const agents = await client.agents('role');
  assert.equal(agents[0]?.provider, 'codex');
  const codexProbe = calls.find(call => call.url.includes('/providers/codex/sessions'));
  assert.ok(codexProbe, 'codex is probed through its provider path');
  assert.equal(new URL(codexProbe.url, 'http://x').searchParams.get('limit'), '1');
  assert.equal(new URL(codexProbe.url, 'http://x').searchParams.get('previews'), null);
});

test('only a directory node with no relay owner reads through an instance binding', async () => {
  const { request, calls } = recorder(() => ({ payload: { code: 0, threads: [{ id: 't', title: 'T' }], nextOffset: null } }));
  const client = createAgentSessionClient(request, '', { node: () => ({ id: 'node:n1', kind: 'instance', name: '测试机1', online: true, status: 'online',
    instanceId: 'n1', agents: [{ agentId: 'agent-1', name: 'Codex', provider: 'codex-desktop' }] }) });
  const agents = await client.agents('role');
  assert.deepEqual(agents[0].binding, { instanceId: 'n1', agentId: 'agent-1' });
  await client.tasks(agents[0], '');
  const list = calls.at(-1)!;
  assert.equal(list.url, '/api/agent/threads');
  assert.equal(list.body.instanceBinding.instanceId, 'n1');
});

test('a closed device is not read at all until it is opened', async () => {
  const { request, calls } = recorder(url => url === '/api/computers'
    ? { payload: directory([
        { id: 'a', instanceId: 'a', kind: 'host', local: true, name: '本机', status: 'online' },
        { id: 'peer:b', instanceId: '', kind: 'host', ownerDeviceId: 'b', name: '远端', status: 'online' }]) }
    : { payload: { code: 0, threads: [], nextOffset: null } });
  const client = createAgentSessionClient(request);
  const nodes = await client.nodes();
  assert.deepEqual(nodes.map(node => node.id), ['local', 'peer:b']);
  // Reading the directory is one request; no computer is opened on its behalf.
  assert.deepEqual(calls.map(call => call.url), ['/api/computers']);
});

test('the directory keeps offline and unknown computers visible with their own status', async () => {
  const { request } = recorder(url => url === '/api/computers'
    ? { payload: directory([
        { id: 'a', instanceId: 'a', kind: 'host', local: true, name: '本机', status: 'online' },
        { id: 'peer:off', instanceId: '', kind: 'host', ownerDeviceId: 'off', name: '离线机', status: 'offline' },
        { id: 'peer:unk', instanceId: '', kind: 'host', ownerDeviceId: 'unk', name: '未知机', status: 'unknown' }]) }
    : { payload: { code: 0, threads: [], nextOffset: null } });
  const nodes = await createAgentSessionClient(request).nodes();
  assert.deepEqual(nodes.map(node => [node.name, node.status]), [['本机', 'online'], ['离线机', 'offline'], ['未知机', 'unknown']]);
});

test('the provider list stays the single source for probe candidates', () => {
  assert.equal(remoteAgentProviders.includes('codex'), true);
  const source = fs.readFileSync(new URL('../../src/plugins/io.rabiroute.manager.persona/web/persona/agentSessionClient.ts', import.meta.url), 'utf8');
  assert.match(source, /SESSION_PAGE_SIZE = 30/);
  assert.match(source, /PROBE_TIMEOUT_MS = 4000/);
});

test('a forced refresh supersedes an in-flight node read instead of joining it', () => {
  const source = fs.readFileSync(new URL('../../src/plugins/io.rabiroute.manager.persona/web/components/PersonaAgentSessions.vue', import.meta.url), 'utf8');
  // Joining an older flight would let pre-clear rows land after the list was emptied.
  assert.match(source, /const running = force \? undefined : deviceFlights\.get\(node\.id\)/);
  assert.match(source, /for \(const request of deviceRequests\.values\(\)\) request\.abort\(\)/);
  assert.match(source, /deviceFlights\.clear\(\)/);
});

test('continuation pages are cancellable and never land in a replaced entry', () => {
  const source = fs.readFileSync(new URL('../../src/plugins/io.rabiroute.manager.persona/web/components/PersonaAgentSessions.vue', import.meta.url), 'utf8');
  assert.match(source, /const moreRequests = new Map<string, AbortController>\(\)/);
  assert.match(source, /entries\.get\(key\) !== entry/);
  assert.match(source, /for \(const request of moreRequests\.values\(\)\) request\.abort\(\)/);
});

test('no dead helper survives the device-directory rework', () => {
  const source = fs.readFileSync(new URL('../../src/plugins/io.rabiroute.manager.persona/web/persona/agentSessionClient.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /nodeReadsInstances/);
});

test('a cancelled read is retried when the tab becomes visible again', () => {
  const source = fs.readFileSync(new URL('../../src/plugins/io.rabiroute.manager.persona/web/components/PersonaAgentSessions.vue', import.meta.url), 'utf8');
  // Leaving the tab aborts; returning must re-enter the read instead of waiting for a user refresh.
  assert.match(source, /if \(!props\.active\) \{ nodeRequest\?\.abort\(\); historyRequest\?\.abort\(\); memberRequest\?\.abort\(\)/);
  assert.match(source, /some\(entry => entry\.error\) \|\| !entries\.size/);
  assert.match(source, /void prefetchDevices\(nodes\.value\)/);
});

test('a session without a title never breaks search or selection', () => {
  const sessions = fs.readFileSync(new URL('../../src/plugins/io.rabiroute.manager.persona/web/components/PersonaAgentSessions.vue', import.meta.url), 'utf8');
  // The owner can return rows with no title; the row keeps its id and search stays total.
  assert.match(sessions, /title: task\.title \|\| task\.id/);
  assert.match(sessions, /\(item\.title \|\| ''\)\.toLowerCase\(\)/);
});

test('running sessions show motion instead of a timestamp, and lists sort newest first', () => {
  const layout = fs.readFileSync(new URL('../../src/plugins/io.rabiroute.manager.persona/web/components/HistoryConversationLayout.vue', import.meta.url), 'utf8');
  assert.match(layout, /v-if="row\.conversation\.running"/);
  assert.match(layout, /v-else :datetime="row\.conversation\.time"/);
  const presentation = fs.readFileSync(new URL('../src/historyConversationPresentation.ts', import.meta.url), 'utf8');
  assert.match(presentation, /historyTimeValue\(right\.time\) - historyTimeValue\(left\.time\)/);
  assert.match(presentation, /sort\(\(left, right\) => historyTimeValue\(right\.latestInProject\)/);
});
