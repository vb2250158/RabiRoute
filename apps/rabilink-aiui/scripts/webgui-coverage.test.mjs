import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {audit, discover, normalizeEndpoint, publicApiTransportPolicy, repoRoot} from './Audit-WebguiCoverage.mjs';
test('nested templates and query suffixes normalize without truncating braces', () => {
  assert.equal(discover('fetch(`${apiBase}/api/scan/agents${params.size ? `?${params}` : ""}`)')[0].endpoint, '/api/scan/agents');
  assert.equal(normalizeEndpoint('/api/roles/${encodeURIComponent(id)}/skills'), '/api/roles/:param/skills');
  assert.equal(normalizeEndpoint('/api/video${path}'), '/api/video:dynamic');
});
test('current UI feature coverage matches the generic Manager transport', () => { assert(audit().contracts > 50); });
test('unknown public APIs reuse transport while protected framing remains denied', () => {
  assert.equal(publicApiTransportPolicy('PUT','/api/new-after-release'),true);
  assert.equal(publicApiTransportPolicy('GET','/api/internal/fixture'),false);
  assert.throws(() => audit(repoRoot,(method,p) => p === '/api/internal/fixture' ? true : publicApiTransportPolicy(method,p)), /Private transport boundary widened/);
});
test('new fetch endpoint is discovered and remains unclassified', async () => {
  const {contracts} = await import('./webgui-coverage-contract.mjs');
  const [item] = discover('fetch("/api/new-dangerous-endpoint", {method:"POST"})');
  assert.equal(item.method,'POST');
  assert.equal(contracts.some(c=>c.endpoint===item.endpoint),false);
  assert.throws(()=>audit(repoRoot,undefined,[{...item,file:'negative-fixture'}]),/Unknown discovered endpoint/);
});
