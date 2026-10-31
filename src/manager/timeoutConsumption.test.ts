import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { configureTimeouts } from '../shared/timeoutSettings.js';
import { QQ_READ_LIMITS } from './qqReadContract.js';
import { qqReadSettings } from '../shared/qqReadSettings.js';
import { requestLocalSpeech } from '../speech/localSpeechClient.js';

test('saved timeout settings change real HTTP request cancellation and preserve explicit operation budgets', async () => {
  const server = http.createServer((_request, response) => { setTimeout(() => { if (!response.destroyed) response.end('ok'); }, 100); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    configureTimeouts({ 'speech.request': 10, 'qq.read': 1234 });
    assert.equal(qqReadSettings.readTimeoutMs, 1234); assert.equal(QQ_READ_LIMITS.timeoutMs, 1234);
    await assert.rejects(requestLocalSpeech(url, '/'), (error: unknown) => error instanceof Error && error.name === 'AbortError');
    configureTimeouts({ 'speech.request': 2000, 'qq.read': 2345 });
    assert.equal(qqReadSettings.readTimeoutMs, 2345); assert.equal(QQ_READ_LIMITS.timeoutMs, 2345);
    assert.equal((await requestLocalSpeech(url, '/')).body.toString(), 'ok');
    await assert.rejects(requestLocalSpeech(url, '/', {}, { timeoutMs: 10 }), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  } finally {
    configureTimeouts({}); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
