import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bindFetchCompatible } from '../bridge-endpoint.mjs';

function requestJson(url, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('malformed JSON returns the existing error response and the same bridge forwards the next original-ID request once', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoai-json-http-'));
  const forwarded = [];
  const upstream = http.createServer(async (request, response) => {
    if (request.method === 'HEAD') { response.writeHead(200).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    forwarded.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  let child, exited;
  t.after(async () => {
    if (child && child.exitCode === null) { child.kill(); await exited; }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  // The bridge itself forwards with Fetch; reuse its owned allocator for a safe upstream port.
  const upstreamUrl = await bindFetchCompatible(upstream, '127.0.0.1', 0);
  child = spawn(process.execPath, [fileURLToPath(new URL('../index.mjs', import.meta.url))], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      HOME: root, USERPROFILE: root, TEMP: root, TMP: root,
      XIAOAI_BRIDGE_HOST: '127.0.0.1', XIAOAI_BRIDGE_PORT: '0',
      XIAOAI_BRIDGE_ENDPOINT_DIRECTORY: path.join(root, 'endpoints'),
      RABIROUTE_WEBHOOK_URL: `${upstreamUrl}/webhook` }
  });
  exited = once(child, 'exit');
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const bridgeUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Private bridge startup did not complete.')), 8000);
    const check = () => {
      const match = stdout.match(/XiaoAI RabiRoute adapter listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); child.stdout.off('data', check); resolve(match[1]); }
    };
    child.stdout.on('data', check);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Private bridge exited during startup: ${code}. ${stderr}`)); });
    check();
  });
  const pid = child.pid;
  const bad = await requestJson(`${bridgeUrl}/v1/xiaoai/transcript`, '{"text":');
  assert.equal(bad.status, 500);
  assert.equal(bad.body.ok, false);
  assert.equal(typeof bad.body.error, 'string');
  assert.equal((await requestJson(`${bridgeUrl}/health`)).status, 200);
  assert.equal(forwarded.length, 0);
  const payload = { text: 'Private fixture', messageId: 'original-message-fixture', sessionId: 'original-session-fixture', deviceId: 'private-device-fixture' };
  const accepted = await requestJson(`${bridgeUrl}/v1/xiaoai/transcript`, JSON.stringify(payload));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.forwarded.messageId, payload.messageId);
  assert.equal(accepted.body.forwarded.sessionId, payload.sessionId);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].messageId, payload.messageId);
  assert.equal(forwarded[0].sessionId, payload.sessionId);
  assert.equal(forwarded[0].text, payload.text);
  assert.equal((await requestJson(`${bridgeUrl}/health`)).status, 200);
  assert.equal(child.pid, pid);
  assert.equal(child.exitCode, null);
  assert.equal(stderr, '');
});
