import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {audit, discover, normalizeEndpoint, relayPolicy, repoRoot} from './Audit-WebguiCoverage.mjs';
test('nested templates and query suffixes normalize without truncating braces', () => {
  assert.equal(discover('fetch(`${apiBase}/api/scan/agents${params.size ? `?${params}` : ""}`)')[0].endpoint, '/api/scan/agents');
  assert.equal(normalizeEndpoint('/api/roles/${encodeURIComponent(id)}/skills'), '/api/roles/:param/skills');
  assert.equal(normalizeEndpoint('/api/video${path}'), '/api/video:dynamic');
});
test('current explicit contracts pass actual Relay method policy', () => { assert(audit().contracts > 50); });
test('sensitive permission widening is rejected, even if UI has no matching literal', () => {
  const real = relayPolicy(fs.readFileSync(path.join(repoRoot,'scripts/rabilink-relay-server.mjs'),'utf8'));
  assert.throws(() => audit(repoRoot,(method,p) => p === '/api/webgui-access' ? true : real(method,p)), /Relay permission mismatch/);
  assert.throws(() => audit(repoRoot,(method,p) => p === '/api/rabilink/device/knowledge' ? true : real(method,p)), /Relay permission mismatch/);
});
test('new fetch endpoint is discovered and remains unclassified', async () => {
  const {contracts} = await import('./webgui-coverage-contract.mjs');
  const [item] = discover('fetch("/api/new-dangerous-endpoint", {method:"POST"})');
  assert.equal(item.method,'POST');
  assert.equal(contracts.some(c=>c.endpoint===item.endpoint),false);
  assert.throws(()=>audit(repoRoot,undefined,[{...item,file:'negative-fixture'}]),/Unknown discovered endpoint/);
});
