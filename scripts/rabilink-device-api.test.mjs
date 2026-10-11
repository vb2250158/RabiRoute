import test from 'node:test';
import assert from 'node:assert/strict';
import { apiRequestHeaderAllowed, validateApiRequest } from '../packages/rabi-api-contract/request.mjs';
import { createDeviceApiService } from './rabilink-device-api.mjs';
import { createApiToolRuntime } from '../apps/rabilink-aiui/utils/api-tool-runtime.js';
const identity = { appId: 'app', bindingId: 'glasses', targetDeviceId: 'pc' };
const ok = { structuredContent: { ok: true, data: { answer: 1 } } };
function fixture(dispatch = async () => ok) { const rows = new Map(); return createDeviceApiService({ load: key => rows.get(key), save: (key, value) => rows.set(key, structuredClone(value)), dispatch }); }
test('future paths, all REST methods, cross-persona requests and unbound connections work', async () => {
  const calls = []; const api = fixture(async (_identity, request) => { calls.push(request); return ok; });
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    await api.request(identity, { method, path: '/api/future/roles/Other/new-operation', operationId: method, body: { roleId: 'Other' } });
  }
  assert.equal(calls.length, 7); assert.equal(calls[3].headers['idempotency-key'], 'POST');
});
test('request cannot introduce another origin, private service, credentials or traversal', () => {
  for (const path of ['https://evil.invalid/api', '//evil.invalid/api', '/api/%252e%252e/secret', '/api/internal/roles', '/__rabilink/knowledge', '/api\\x', '/api/%00']) assert.throws(() => validateApiRequest({ path }));
  assert.throws(() => validateApiRequest({ path: '/api/x', headers: { Authorization: 'secret' } }));
  assert.throws(() => validateApiRequest({ method: 'POST', path: '/api/x' }));
});
test('future business header names preserve metadata without admitting transport credentials', () => {
  const headers = { 'X-Token-Count': '42', 'X-Secret-Version': 'v3', 'X-Api-Key-Count': '2', 'X-Cookie-Schema': 'v4', 'X-Authorization-Mode': 'business-label', 'x-rabiroute-future-contract': 'v2', 'x-rabiroute-expected-application-generation-id': 'generation' };
  assert.deepEqual(validateApiRequest({ path: '/api/future', headers }).headers, Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])));
  for (const name of ['authorization', 'proxy-authorization', 'proxy-authenticate', 'cookie', 'set-cookie', 'x-rabiroute-webgui-token', 'x-rabiroute-host-token', 'x-remote-agent-token', 'x-rabilink-token', 'x-rabilink-internal-hop', 'x-rabilink-tunnel-device-id', 'x-rabiroute-agent-id', 'x-rabiroute-peer-proxy', 'x-rabiroute-relay-proxy', 'host', 'connection', 'upgrade', 'transfer-encoding', 'content-length', 'forwarded', 'x-forwarded-for']) {
    assert.equal(apiRequestHeaderAllowed(name.toUpperCase()), false, name);
    assert.throws(() => validateApiRequest({ path: '/api/future', headers: { [name]: 'forged' } }), { code: 'API_HEADERS_INVALID' });
  }
});
test('mutation replay and restart require readback; conflicting original intent is rejected', async () => {
  let calls = 0; const api = fixture(async () => { calls++; return ok; });
  const request = { method: 'POST', path: '/api/x', operationId: 'one', body: { value: 1 } };
  await api.request(identity, request);
  assert.equal((await api.request(identity, request)).structuredContent.uncertain, true);
  await assert.rejects(api.request(identity, { ...request, body: { value: 2 } }), /CONFLICT/);
  assert.equal(calls, 1); assert.equal(api.receipt(identity, 'one').state, 'completed');
});
test('pending persistence happens before dispatch and failure prevents a write', async () => {
  let calls = 0; const api = createDeviceApiService({ load: () => [], save: () => { throw Error('disk'); }, dispatch: async () => { calls++; } });
  await assert.rejects(api.request(identity, { method: 'DELETE', path: '/api/x', operationId: 'one' })); assert.equal(calls, 0);
});
test('AIUI generic tools need no persona and preserve a stable mutation identity', async () => {
  let rows = [], calls = [];
  const runtime = createApiToolRuntime({ sessionId: 'model-1', storage: { load: () => rows, save: value => { rows = value; } }, call: async request => { calls.push(request); return ok; } });
  assert.equal((await runtime.loadTools()).length, 2);
  const event = { functionName: 'rabi_api_call', callId: 'call-1', isComplete: true, arguments: { method: 'POST', path: '/api/roles/Other/plans', body: {} } };
  await runtime.handleToolCall(event); await runtime.handleToolCall(event);
  assert.equal(calls.length, 1); assert.equal(calls[0].operationId, 'model-1:call-1');
  runtime.dispose(); await assert.rejects(runtime.handleToolCall(event));
});
