import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { plugin_init, plugin_get_config, plugin_set_config } from './index.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-plugin-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map(), register = method => (route, handler) => handlers.set(`${method} ${route}`, handler);
  const ctx = { configPath: path.join(root, 'plugin.json'), logger: { info() {}, warn() {} }, router: {
    get: register('GET'), getNoAuth: register('GET'), post: register('POST'), postNoAuth: register('POST'), static() {}, page() {}
  } };
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } });
  return { ctx, handlers, response };
}

test('bad native config stays local, survives rejected saves, and recovers after the original file is repaired', async t => {
  const f = await fixture(t), raw = '{broken';
  fs.writeFileSync(f.ctx.configPath, raw);
  await plugin_init(f.ctx);
  assert.ok(f.handlers.has('GET /gateways'), 'The optional config failure does not stop native plugin registration.');
  const response = f.response(); f.handlers.get('GET /config')({}, response);
  assert.equal(response.statusCode, 503);
  await assert.rejects(plugin_get_config(), /plugin.json/);
  await assert.rejects(plugin_set_config(f.ctx, { managerUrl: 'http://new.example' }), /plugin.json/);
  assert.equal(fs.readFileSync(f.ctx.configPath, 'utf8'), raw);
  fs.writeFileSync(f.ctx.configPath, JSON.stringify({ managerUrl: 'http://original.example', extra: 'preserved' }));
  await plugin_set_config(f.ctx, { managerUrl: 'http://repaired.example' });
  assert.deepEqual(await plugin_get_config(), { managerUrl: 'http://repaired.example', extra: 'preserved' });
});

test('a failed native config write cannot replace the saved file or the Manager connection in the owner cache', async t => {
  const f = await fixture(t);
  await plugin_init(f.ctx);
  assert.deepEqual(await plugin_get_config(), { managerUrl: '' });
  await plugin_set_config(f.ctx, { managerUrl: 'http://original.example', extra: 'kept' });
  const original = fs.readFileSync(f.ctx.configPath, 'utf8');
  const denied = t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('write denied'), { code: 'EACCES' }); });
  await assert.rejects(plugin_set_config(f.ctx, { managerUrl: 'http://uncommitted.example' }), /write denied/);
  denied.mock.restore();
  let requested;
  const fetchMock = t.mock.method(globalThis, 'fetch', async url => { requested = String(url); return Response.json({ code: 0 }); });
  await f.handlers.get('GET /gateways')({}, f.response());
  fetchMock.mock.restore();
  assert.equal(requested, 'http://original.example/gateways');
  assert.equal(fs.readFileSync(f.ctx.configPath, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(path.dirname(f.ctx.configPath)), ['plugin.json']);
});
