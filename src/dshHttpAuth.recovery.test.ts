import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dshAuthenticatedFetch } from './dshHttpAuth.js';
import { DshConnectionStore } from './dshConnectionStore.js';

async function fixture(run: (f: { origin: string; store: DshConnectionStore; log: string; cookie: string }) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auto-connect-'));
  const names = ['RABIROUTE_STATE_ROOT', 'RABI_DSH_AUTH_FILE', 'DSH_HOME', 'DSH_WEB_URL'] as const;
  const old = names.map(name => process.env[name]);
  const priorFetch = globalThis.fetch;
  process.env.RABIROUTE_STATE_ROOT = root;
  process.env.DSH_HOME = path.join(root, 'home');
  delete process.env.RABI_DSH_AUTH_FILE;
  delete process.env.DSH_WEB_URL;
  const origin = 'http://127.0.0.1:39319';
  const log = path.join(process.env.DSH_HOME, 'logs', 'web-host.stdout.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, `dsh web: ${origin}/?token=fixture-current\n`);
  const cookie = `dsh-auth-${createHash('sha256').update(new URL(origin).host).digest('base64url')}=v1.current.sig`;
  const store = new DshConnectionStore(path.join(root, 'data', 'dsh-connections', 'connections.json'));
  try { await run({ origin, store, log, cookie }); }
  finally {
    globalThis.fetch = priorFetch;
    names.forEach((name, i) => { if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i]; });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function login(cookie: string) {
  return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': `${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600` } });
}

test('running local DSH connects without a config file or manual login action', () => fixture(async ({ origin, cookie }) => {
  let exchanges = 0, reads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, origin);
    if (url.pathname === '/') { exchanges++; return login(cookie); }
    reads++;
    assert.equal(new Headers(init?.headers).get('cookie'), cookie);
    return Response.json({ ok: true });
  };
  assert.equal((await dshAuthenticatedFetch(origin, 'session/list', '{}')).status, 200);
  assert.equal(exchanges, 1);
  assert.equal(reads, 1);
}));

test('expired authorization restores and persists before the original RPC', () => fixture(async ({ origin, store, cookie }) => {
  store.connect(origin, { cookie: 'dsh-auth-fixture=v1.old.sig', expiresAt: Date.now() + 60000 }, 0);
  store.invalidate(origin, 'dsh-auth-fixture=v1.old.sig');
  let exchanges = 0, writes = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/') { exchanges++; return login(cookie); }
    assert.equal(new Headers(init?.headers).get('cookie'), cookie);
    const body = JSON.parse(String(init?.body));
    if (url.pathname.endsWith('/prompt')) writes++;
    return Response.json({ rpcId: body.rpcId, result: { ok: true, value: { items: [] } } });
  };
  assert.equal((await dshAuthenticatedFetch(origin, 'session/prompt', '{}')).status, 200);
  assert.equal(store.resolve(origin)?.state, 'connected');
  assert.equal(exchanges, 1);
  assert.equal(writes, 1);
  assert.doesNotMatch(fs.readFileSync(store.filePath, 'utf8'), /v1\.current|fixture-current/);
}));

test('stale saved login recovers a rejected list once, never a rejected prompt', () => fixture(async ({ origin, store, cookie }) => {
  store.connect(origin, { cookie: 'dsh-auth-fixture=v1.old.sig', expiresAt: Date.now() + 60000 }, 0);
  let exchanges = 0, reads = 0, writes = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/') { exchanges++; return login(cookie); }
    if (url.pathname.endsWith('/prompt')) { writes++; return new Response(null, { status: 401 }); }
    reads++;
    if (reads === 1) return new Response(null, { status: 401 });
    assert.equal(new Headers(init?.headers).get('cookie'), cookie);
    const body = JSON.parse(String(init?.body));
    return Response.json({ rpcId: body.rpcId, result: { ok: true } });
  };
  assert.equal((await dshAuthenticatedFetch(origin, 'session/list', '{}')).status, 200);
  assert.equal(exchanges, 1);
  assert.equal(reads, 3); // rejected read, credential verification, original read
  await assert.rejects(dshAuthenticatedFetch(origin, 'session/prompt', '{}'), /not replayed/);
  assert.equal(writes, 1);
  assert.equal(exchanges, 1);
}));

test('explicit disconnect prevents automatic login and disconnect during recovery wins', () => fixture(async ({ origin, store, cookie }) => {
  store.disconnect(origin, 0);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return login(cookie); };
  await assert.rejects(dshAuthenticatedFetch(origin, 'session/list', '{}'), /explicitly disconnected/);
  assert.equal(calls, 0);
  store.connect(origin, { cookie, expiresAt: Date.now() + 60000 }, 1);
  store.invalidate(origin, cookie);
  globalThis.fetch = async (input, init) => {
    calls++;
    if (new URL(String(input)).pathname === '/') {
      store.disconnect(origin, store.readMetadata().revision);
      return login(cookie);
    }
    const body = JSON.parse(String(init?.body));
    return Response.json({ rpcId: body.rpcId, result: { ok: true } });
  };
  await assert.rejects(dshAuthenticatedFetch(origin, 'session/prompt', '{}'), /authorization changed/);
  assert.equal(store.resolve(origin)?.state, 'disconnected');
  assert.equal(calls, 2);
}));

test('missing or foreign current log cannot restore an expired connection', () => fixture(async ({ origin, store, log, cookie }) => {
  store.connect(origin, { cookie, expiresAt: Date.now() + 60000 }, 0);
  store.invalidate(origin, cookie);
  fs.writeFileSync(log, 'dsh web: http://127.0.0.1:39320/?token=foreign-fixture\n');
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not dispatch'); };
  await assert.rejects(dshAuthenticatedFetch(origin, 'session/list', '{}'), /current local launch log is unavailable/);
  assert.equal(calls, 0);
}));

test('retired default log mapping uses the current local launcher log', () => fixture(async ({ origin, store, log, cookie }) => {
  const config = path.join(path.dirname(path.dirname(store.filePath)), 'dsh-auth.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ endpoints: [{ baseUrl: origin, launchLogPath: path.join(path.dirname(log), 'retired.log') }] }));
  store.connect(origin, { cookie, expiresAt: Date.now() + 60000 }, 0);
  store.invalidate(origin, cookie);
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/') return login(cookie);
    const body = JSON.parse(String(init?.body));
    return Response.json({ rpcId: body.rpcId, result: { ok: true } });
  };
  assert.equal((await dshAuthenticatedFetch(origin, 'session/list', '{}')).status, 200);
  assert.equal(store.resolve(origin)?.state, 'connected');
}));
