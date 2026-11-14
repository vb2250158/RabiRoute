import test from 'node:test';
import assert from 'node:assert/strict';
import { openAssistantServer } from '../src/server.mjs';
test('loopback control requires capability and matching origin; closing clients does not stop owner', async () => {
  let stopped = 0, commands = 0;
  const server = await openAssistantServer({ host: { state: async () => ({ alive: true }), command: async () => { commands++; return { ok: true }; }, dispose: async () => { stopped++; } }, messages: () => [], directory: '.' });
  const headers = { Authorization: 'Bearer ' + new URL(server.url).hash.slice(1), 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(server.origin + '/api/state')).status, 401);
    assert.equal((await fetch(server.origin + '/api/state', { headers: { ...headers, Origin: 'https://example.org' } })).status, 403);
    assert.equal((await fetch(server.origin + '/api/command', { method: 'POST', headers: { ...headers, Origin: 'https://example.org' }, body: '{"action":"start"}' })).status, 403);
    assert.deepEqual(await (await fetch(server.origin + '/api/state', { headers })).json(), { alive: true });
    assert.equal(commands, 0); assert.equal(stopped, 0);
    assert.equal((await fetch(server.origin + '/api/command', { method: 'POST', headers, body: '{"action":"stop"}' })).status, 200);
    assert.equal(commands, 1); assert.equal(stopped, 0);
  } finally { await server.close(); }
});
