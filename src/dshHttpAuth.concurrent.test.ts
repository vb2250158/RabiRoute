import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dshAuthenticatedFetch } from './dshHttpAuth.js';

test('concurrent authenticated reads share exchange; transport secrets never escape errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-auth-concurrent-'));
  const old = process.env.RABI_DSH_AUTH_FILE;
  const oldFetch = globalThis.fetch;
  const origin = 'http://127.0.0.1:39274';
  const config = path.join(dir, 'config.json');
  const log = path.join(dir, 'log');
  process.env.RABI_DSH_AUTH_FILE = config;
  let exchanges = 0;
  let rpc = 0;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const exchangeEntered = new Promise<void>(resolve => { entered = resolve; });
  try {
    await fs.writeFile(config, JSON.stringify({ endpoints: [{ baseUrl: origin, launchLogPath: log }] }));
    await fs.writeFile(log, `dsh web: ${origin}/?token=fixture-secret\n`);
    globalThis.fetch = (async (_input, init) => {
      if (init?.method !== 'POST') {
        exchanges++;
        entered();
        await hold;
        return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': 'dsh-auth-fixture=one.sig; Path=/; HttpOnly; Max-Age=60' } });
      }
      rpc++;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const first = dshAuthenticatedFetch(origin, 'session/list', '{}');
    await exchangeEntered;
    const second = dshAuthenticatedFetch(origin, 'session/list', '{}');
    release();
    await Promise.all([first, second]);
    assert.equal(exchanges, 1);
    assert.equal(rpc, 2);
    globalThis.fetch = (async () => { throw new Error('fixture-secret cookie=one.sig'); }) as typeof fetch;
    await assert.rejects(dshAuthenticatedFetch(origin, 'session/list', '{}'), error => error instanceof Error && !error.message.includes('fixture-secret') && !error.message.includes('one.sig'));
  } finally {
    release();
    globalThis.fetch = oldFetch;
    if (old === undefined) delete process.env.RABI_DSH_AUTH_FILE; else process.env.RABI_DSH_AUTH_FILE = old;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
