import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dshAuthenticatedFetch } from './dshHttpAuth.js';

test('launch exchange is origin bound; RPC 401 and redirects never replay writes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-auth-test-'));
  const oldEnv = process.env.RABI_DSH_AUTH_FILE;
  const oldFetch = globalThis.fetch;
  const origin = 'http://127.0.0.1:39271';
  const log = path.join(dir, 'launch.log');
  const config = path.join(dir, 'auth.json');
  process.env.RABI_DSH_AUTH_FILE = config;
  let exchanges = 0;
  let writes = 0;
  let rpcStatus = 200;
  try {
    await fs.writeFile(config, JSON.stringify({ endpoints: [{ baseUrl: origin, launchLogPath: log }] }));
    await fs.writeFile(log, `dsh web: ${origin}/?token=fixture-token\ndsh web: http://127.0.0.1:39272/?token=wrong-origin\n`);
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, origin);
      assert.equal(init?.redirect, 'manual');
      if (url.pathname === '/') {
        exchanges++;
        assert.equal(url.searchParams.get('token'), 'fixture-token');
        return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': 'dsh-auth-fixture=fixture.signature; Path=/; HttpOnly; SameSite=Strict' } });
      }
      writes++;
      assert.equal(new Headers(init?.headers).get('cookie'), 'dsh-auth-fixture=fixture.signature');
      return new Response(null, { status: rpcStatus, headers: { location: 'https://invalid.example/' } });
    }) as typeof fetch;
    await dshAuthenticatedFetch(origin, 'session.prompt', '{}');
    assert.equal(exchanges, 1);
    rpcStatus = 401;
    await assert.rejects(dshAuthenticatedFetch(origin, 'session.prompt', '{}'), /not replayed/);
    assert.equal(writes, 2);
    assert.equal(exchanges, 1);
    rpcStatus = 307;
    assert.equal((await dshAuthenticatedFetch(origin, 'session.prompt', '{}')).status, 307);
    assert.equal(exchanges, 2);
    assert.equal(writes, 3);
    await fs.writeFile(config, JSON.stringify({ endpoints: [{ baseUrl: 'https://invalid.example', launchLogPath: log }] }));
    await assert.rejects(dshAuthenticatedFetch('https://invalid.example', 'session.list', '{}'), /loopback/);
    assert.equal(writes, 3);
    await assert.rejects(dshAuthenticatedFetch(origin, '../escape', '{}'), /method is invalid/);
    await fs.writeFile(config, JSON.stringify({ endpoints: [{ baseUrl: origin, launchLogPath: log }, { baseUrl: origin, launchLogPath: log }] }));
    await assert.rejects(dshAuthenticatedFetch(origin, 'session/list', '{}'), /duplicate/);
    await fs.writeFile(config, JSON.stringify({ endpoints: [{ baseUrl: 'http://localhost:39271', launchLogPath: log }] }));
    let unmatchedCalls = 0;
    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), `${origin}/api/session/list`);
      assert.equal(new Headers(init?.headers).has('cookie'), false);
      assert.equal(init?.redirect, 'manual');
      unmatchedCalls++;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    assert.equal((await dshAuthenticatedFetch(origin, 'session/list', '{}')).status, 200);
    assert.equal(unmatchedCalls, 1);
    await fs.writeFile(config, '{invalid');
    await assert.rejects(dshAuthenticatedFetch(origin, 'session/list', '{}'), /invalid JSON/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldEnv === undefined) delete process.env.RABI_DSH_AUTH_FILE; else process.env.RABI_DSH_AUTH_FILE = oldEnv;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
