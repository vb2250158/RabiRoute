import test from 'node:test';
import assert from 'node:assert/strict';
import {audit, discover, normalizeEndpoint, publicApiTransportPolicy, repoRoot} from './Audit-WebguiCoverage.mjs';
import { API_METHODS } from '../../../packages/rabi-api-contract/request.mjs';
test('nested templates and query suffixes normalize without truncating braces', () => {
  assert.equal(discover('fetch(`${apiBase}/api/scan/agents${params.size ? `?${params}` : ""}`)')[0].endpoint, '/api/scan/agents');
  assert.equal(normalizeEndpoint('/api/roles/${encodeURIComponent(id)}/skills'), '/api/roles/:param/skills');
  assert.equal(normalizeEndpoint('/api/video${path}'), '/api/video:dynamic');
});
test('current UI feature coverage checks every shared transport method', () => {
  const result = audit();
  assert(result.contracts > 50);
  assert(result.transportPaths > 0);
  assert.equal(result.checkedMethods, API_METHODS.length);
  assert.equal(Object.hasOwn(result, 'unsupported'), false);
});
test('unknown public APIs reuse transport while protected framing remains denied', () => {
  assert.equal(publicApiTransportPolicy('PUT','/api/new-after-release'),true);
  assert.equal(publicApiTransportPolicy('GET','/api/internal/fixture'),false);
  assert.throws(() => audit(repoRoot,(method,p) => p === '/api/internal/fixture' ? true : publicApiTransportPolicy(method,p)), /Private transport boundary widened/);
});
test('a future public fetch endpoint works without adding a catalog row', async () => {
  const {contracts} = await import('./webgui-coverage-contract.mjs');
  const [item] = discover('fetch("/api/new-after-release", {method:"POST"})');
  assert.equal(item.method,'POST');
  assert.equal(contracts.some(c=>c.endpoint===item.endpoint),false);
  const visited = new Set();
  audit(repoRoot, (method, endpoint) => {
    if (endpoint === item.endpoint) visited.add(method);
    return publicApiTransportPolicy(method, endpoint);
  }, [{...item,file:'future-api-fixture'}]);
  assert.deepEqual([...visited].sort(), [...API_METHODS].sort());
});
test('unlisted companion and dynamic scan patterns reuse generic transport', () => {
  const patterns = ['/api/roles/:param/companion:dynamic', '/api/scan/agents:dynamic', '/api/roles/:param/companion/last'];
  const visited = new Set();
  audit(repoRoot, (method, endpoint) => {
    visited.add(endpoint);
    return publicApiTransportPolicy(method, endpoint);
  }, patterns.map(endpoint => ({endpoint, method:'GET', file:'dynamic-api-fixture'})));
  for (const sample of ['/api/roles/fixture/companion/fixture', '/api/scan/agents/fixture', '/api/roles/fixture/companion/last']) assert(visited.has(sample));
});
test('a transport restriction on a future write is still detected', () => {
  const item = {endpoint:'/api/new-after-release',method:'GET',file:'future-denial-fixture'};
  assert.throws(() => audit(repoRoot, (method, endpoint) => !(method === 'POST' && endpoint === item.endpoint) && publicApiTransportPolicy(method, endpoint), [item]), /Public transport rejected discovered Manager path POST \/api\/new-after-release/);
});
test('private transport boundaries are audited for every shared method', () => {
  for (const endpoint of ['/api/internal/fixture','/__rabilink/fixture','//external.invalid/fixture']) {
    for (const method of API_METHODS) assert.equal(publicApiTransportPolicy(method,endpoint),false);
    assert.throws(() => audit(repoRoot, (method, path) => (method === 'POST' && path === endpoint) || publicApiTransportPolicy(method,path)), /Private transport boundary widened: POST/);
  }
});
