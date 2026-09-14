import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dshAuthenticatedFetch } from './dshHttpAuth.js';

test('authentication fails closed on redirects, missing cookies and malformed configuration', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-auth-negative-'));
  const prior = process.env.RABI_DSH_AUTH_FILE;
  const original = globalThis.fetch;
  const config = path.join(dir, 'config.json');
  const log = path.join(dir, 'stdout.log');
  const origin = 'http://127.0.0.1:39273';
  process.env.RABI_DSH_AUTH_FILE = config;
  let calls = 0;
  let headers: Record<string, string> = { location: 'https://invalid.example/' };
  try {
    await fs.writeFile(config, JSON.stringify({ endpoints: [{ baseUrl: origin, launchLogPath: log }] }));
    await fs.writeFile(log, `dsh web: ${origin}/?token=private-fixture\n`);
    globalThis.fetch = (async (_input, init) => {
      calls++;
      assert.equal(init?.redirect, 'manual');
      assert.notEqual(init?.method, 'POST');
      return new Response(null, { status: 303, headers });
    }) as typeof fetch;
    await assert.rejects(dshAuthenticatedFetch(origin, 'session/prompt', '{}'), /exchange rejected/);
    assert.equal(calls, 1);
    headers = { location: '/' };
    await assert.rejects(dshAuthenticatedFetch(origin, 'session/prompt', '{}'), /session cookie/);
    assert.equal(calls, 2);
    headers = { location: '/', 'set-cookie': 'dsh-other=abc; Path=/; HttpOnly' };
    await assert.rejects(dshAuthenticatedFetch(origin, 'session/prompt', '{}'), /session cookie/);
    for (const age of ['0', '-1', 'bad']) {
      headers = { location: '/', 'set-cookie': `dsh-auth-fixture=abc.sig; Path=/; HttpOnly; Max-Age=${age}` };
      await assert.rejects(dshAuthenticatedFetch(origin, 'session/prompt', '{}'), /expired cookie/);
    }
    await fs.writeFile(config, JSON.stringify({ endpoints: [] }));
    await assert.rejects(dshAuthenticatedFetch(origin, 'session/prompt', '{}'), /no matching endpoint/);
    await fs.unlink(config);
    await assert.rejects(dshAuthenticatedFetch(origin, 'session/prompt', '{}'), /configuration is unreadable/);
    await fs.writeFile(config, 'null');
    await assert.rejects(dshAuthenticatedFetch(origin, 'session/list', '{}'), /requires endpoints/);
    assert.equal(calls, 6);
    await assert.rejects(dshAuthenticatedFetch('secret-invalid-url', 'session/list', '{}'), error => error instanceof Error && !error.message.includes('secret-invalid-url'));
  } finally {
    globalThis.fetch = original;
    if (prior === undefined) delete process.env.RABI_DSH_AUTH_FILE; else process.env.RABI_DSH_AUTH_FILE = prior;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
