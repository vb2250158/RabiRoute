import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostEndpointSession } from '../lib/host-endpoint.mjs';
test('MCP discovers a running custom installation when the standard Host is absent', async () => {
  const identity = { managerBaseUrl: 'http://127.0.0.1:51234', applicationGenerationId: 'g', managerInstanceId: 'i' };
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const session = createHostEndpointSession({ env: { LOCALAPPDATA: 'C:/fixture' }, spawnSync: () => ({ error: missing }),
    fetchImpl: async () => Response.json({ ...identity, health: { live: true, requiredReady: true, state: 'healthy' } }),
    discoveryOptions: { platform: 'win32', readFile: async () => { throw missing; }, execFile: async file => {
      if (file === 'powershell.exe') return { stdout: JSON.stringify('G:/fixture/RabiRouteHost.exe') };
      if (file === 'G:/fixture/RabiRouteHost.exe') return { stdout: JSON.stringify({ ok: true, ...identity }) };
      throw missing;
    } } });
  const resolved = await session.ensure();
  assert.equal(resolved.managerUrl, identity.managerBaseUrl);
  assert.equal(resolved.meta.managerInstanceId, identity.managerInstanceId);
});
