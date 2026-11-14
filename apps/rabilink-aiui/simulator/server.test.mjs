import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { startSimulator } from './server.mjs';

test('local API credentials stay server-side; rejects foreign origins and unsigned requests', async t => {
  const app = await startSimulator({ bundleFiles: {}, initialConfig: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'private-test-key', model: 'test-model' } });
  t.after(() => app.close());
  const bootstrap = await (await fetch(`${app.origin}/bootstrap`)).json();
  assert.equal(bootstrap.config.hasApiKey, true);
  assert.equal(JSON.stringify(bootstrap).includes('private-test-key'), false);
  assert.equal((await fetch(`${app.origin}/api/config`, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(`${app.origin}/bootstrap`, { headers: { origin: 'https://untrusted.example' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get(`${app.origin}/bootstrap`, { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  const headers = { 'x-simulator-token': bootstrap.token };
  const result = await fetch(`${app.origin}/api/config`, { method: 'POST', headers, body: JSON.stringify({ baseUrl: 'https://user:password@example.com', model: 'test' }) });
  assert.equal(result.status, 400);
  assert.equal((await fetch(`${app.origin}/server.mjs`)).status, 404);
});

test('proxies SSE unchanged, pins configured model, and does not disclose upstream errors', async t => {
  const calls = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({ url: request.url, auth: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    if (calls.length === 1) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    } else {
      response.writeHead(401); response.end('private-upstream-detail');
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const app = await startSimulator({ bundleFiles: {}, initialConfig: { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'configured-model', apiKey: 'test-key' } });
  t.after(() => app.close());
  const { token } = await (await fetch(`${app.origin}/bootstrap`)).json();
  const invoke = () => fetch(`${app.origin}/api/chat`, { method: 'POST', headers: { 'x-simulator-token': token }, body: JSON.stringify({ model: 'injected-model', messages: [{ role: 'user', content: 'test' }] }) });
  const good = await invoke();
  assert.equal(good.status, 200);
  assert.match(await good.text(), /data: \[DONE\]/);
  assert.equal(calls[0].auth, 'Bearer test-key');
  assert.equal(calls[0].body.model, 'configured-model');
  assert.equal(calls[0].body.stream, true);
  const bad = await invoke();
  assert.equal(bad.status, 502);
  assert.equal((await bad.text()).includes('private-upstream-detail'), false);
});

test('changing provider cannot forward the previous provider credential', async t => {
  const authorizations = [];
  const upstream = http.createServer(async (request, response) => {
    for await (const _ of request) {}
    authorizations.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/first`;
  const app = await startSimulator({ bundleFiles: {}, initialConfig: { baseUrl, model: 'test', apiKey: 'original-provider-key' } });
  t.after(() => app.close());
  const { token } = await (await fetch(`${app.origin}/bootstrap`)).json();
  const headers = { 'x-simulator-token': token, 'content-type': 'application/json' };
  const configure = async input => (await fetch(`${app.origin}/api/config`, { method: 'POST', headers, body: JSON.stringify(input) })).json();
  assert.equal((await configure({ baseUrl: baseUrl + '/', model: 'test' })).hasApiKey, true);
  assert.equal((await configure({ baseUrl: baseUrl.replace('/first', '/second'), model: 'test' })).hasApiKey, false);
  const response = await fetch(`${app.origin}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ messages: [] }) });
  await response.text();
  assert.deepEqual(authorizations, [undefined]);
  assert.equal((await configure({ baseUrl, model: 'test', apiKey: 'replacement-key' })).hasApiKey, true);
});
