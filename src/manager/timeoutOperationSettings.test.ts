import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { configureTimeouts, readRegisteredTimeoutCatalog } from '../shared/timeoutSettings.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { fixtureApiContract } from './apiOperationContractFixtures.js';

test('configured operation deadlines affect subsequent real requests and retire with the registration', { timeout: 10000 }, async t => {
  const base = fixtureApiContract(), operationId = 'fixture.timeouts.live', key = `api.${operationId}.deadline`;
  let entered!: () => void, release!: () => void, firstSignal: AbortSignal | undefined;
  const admission = new Promise<void>(resolve => { entered = resolve; }), firstGate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations('timeout-settings-fixture', [{
    contract: { ...base, operationId, request: { ...base.request, deadlineMs: 500 } },
    handler: async input => {
      if (++calls === 1) { firstSignal = input.signal; entered(); await firstGate; }
      else await new Promise(resolve => setTimeout(resolve, 100));
      return { status: 200, body: { ok: true, value: 1 } };
    }
  }]);
  const server = http.createServer((request, response) => registry.handle(request, new URL(request.url!, 'http://fixture'), response));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { release(); configureTimeouts({}); server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const request = () => fetch(`http://127.0.0.1:${address.port}/api/example/records/one`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"value":1}' });
  assert.equal(readRegisteredTimeoutCatalog().find(entry => entry.key === key)?.defaultMs, 500);
  configureTimeouts({ [key]: 1000 });
  const first = request(); await admission;
  configureTimeouts({ [key]: 15 });
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(firstSignal?.aborted, false);
  release(); assert.equal((await first).status, 200);
  assert.equal((await request()).status, 408);
  configureTimeouts({ [key]: 1000 }); assert.equal((await request()).status, 200);
  await registration.dispose(); assert.equal(readRegisteredTimeoutCatalog().some(entry => entry.key === key), false);
});
