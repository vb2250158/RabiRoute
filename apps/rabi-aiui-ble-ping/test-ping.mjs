import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ink = fs.readFileSync(new URL('pages/ping/index.ink', import.meta.url), 'utf8');
const js = ink.match(/<script setup>([\s\S]*?)<\/script>/)[1];
JSON.parse(ink.match(/<script def>([\s\S]*?)<\/script>/)[1]);
const config = JSON.parse(fs.readFileSync(new URL('app.json', import.meta.url), 'utf8'));
assert.deepEqual(config.pages, ['pages/ping/index']);

function fixture({ badReply = false, unavailable = false, delayedRead = false, devices = 1, scanError = false, scanSyncError = false, listenerError = false, callbackError = false, remembered = false, verified = false } = {}) {
  let lastWrite = '', disconnects = 0, resolveRead, scans = 0, stops = 0, timeout;
  let stored = verified ? { id: 'test-phone', service: '78c20001-48a3-4b18-a401-819ec0200001' } : undefined;
  const characteristic = {
    async writeValueWithResponse(value) { lastWrite = String.fromCharCode(...value); },
    async readValue() {
      if (delayedRead) await new Promise(resolve => { resolveRead = resolve; });
      return Array.from(badReply ? 'pong:00000000' : lastWrite.replace('ping:', 'pong:'), ch => ch.charCodeAt(0));
    },
  };
  const device = { id: 'test-phone', gatt: {
    async connect() { return { async getPrimaryService(uuid) {
      assert.equal(uuid, '78c20001-48a3-4b18-a401-819ec0200001');
      return { async getCharacteristic(id) { assert.equal(id, '78c20002-48a3-4b18-a401-819ec0200001'); return characteristic; } };
    } }; },
    async disconnect() { disconnects++; },
  } };
  const context = vm.createContext({ console: { info() {}, warn() {} },
    wx: { getStorageSync() { return stored; }, setStorageSync(key, value) { stored = value; } },
    setTimeout(fn, ms) { if (ms === 30000) timeout = fn; return setTimeout(fn, ms === 4000 ? 5 : ms); },
    clearTimeout(value) { assert.notEqual(value, null); clearTimeout(value); }, Uint8Array,
    crypto: { getRandomValues(bytes) { bytes.set([1, 2, 3, 4]); } },
    navigator: { bluetooth: {
      async getAvailability() { return !unavailable; },
      async getDevices() { return remembered ? [device] : []; },
      scanDevices(options) {
        scans++;
        assert.equal(options.filters[0].services[0], '78c20001-48a3-4b18-a401-819ec0200001');
        if (scanSyncError) throw new Error('QuickJS library created a unknown error');
        if (scanError) return Promise.reject(new Error('InkView not interactive'));
        return Promise.resolve({ onDeviceFound(fn) {
          if (listenerError) throw new TypeError('listener registration failed');
          if (callbackError) { fn(null); return; }
          for (let i = 0; i < devices; i++) fn({ device: { ...device, id: 'phone-' + i } });
        }, offDeviceFound() {}, stop() { stops++; } });
      },
    } },
  });
  const page = vm.runInContext(js.replace("import wx from 'wx';", '').replace('export default', 'globalThis.page ='), context);
  page.setData = values => Object.assign(page.data, values);
  return { page, state: () => ({ lastWrite, disconnects, scans, stops }), resolveRead: () => resolveRead(), timeout: () => timeout(), reading: () => !!resolveRead };
}

const valid = fixture();
await valid.page.test();
assert.match(valid.page.data.status, /^通过/);
assert.equal(valid.state().lastWrite, 'ping:01020304');
assert.equal(valid.state().disconnects, 1);
assert.equal(valid.page.data.busy, false);
const mismatch = fixture({ badReply: true });
await mismatch.page.test();
assert.match(mismatch.page.data.status, /nonce 不匹配/);
const absent = fixture({ unavailable: true });
await absent.page.test();
assert.match(absent.page.data.status, /BLE 不可用/);
const hidden = fixture({ delayedRead: true });
const pending = hidden.page.test();
while (!hidden.reading()) await new Promise(resolve => setTimeout(resolve, 1));
hidden.page.onHide();
hidden.resolveRead();
await pending;
assert.equal(hidden.page.data.result, '中断：页面隐藏');
assert.equal(hidden.page.data.stage, '读取 pong');
assert.equal(hidden.state().disconnects, 1);
hidden.page.onShow();
assert.equal(hidden.state().scans, 1);
assert.match(hidden.page.data.reason, /可手动重试/);
valid.page.onHide();
assert.match(valid.page.data.result, /^通过/);
valid.page.onUnload();
assert.match(valid.page.data.result, /^通过/);
for (const count of [0, 2]) {
  const ambiguous = fixture({ devices: count });
  await ambiguous.page.test();
  assert.match(ambiguous.page.data.result, /未发现|多个/);
  assert.equal(ambiguous.state().lastWrite, '');
  assert.equal(ambiguous.state().stops, 1);
}
const gate = fixture({ scanError: true });
gate.page.onShow(); gate.page.onReady(); gate.page.onReady();
await new Promise(resolve => setTimeout(resolve, 10));
assert.match(gate.page.data.result, /not interactive/);
gate.page.onHide(); gate.page.onShow();
assert.equal(gate.state().scans, 1);
const canceled = fixture({ delayedRead: true });
const unfinished = canceled.page.test();
while (!canceled.reading()) await new Promise(resolve => setTimeout(resolve, 1));
canceled.timeout(); canceled.resolveRead(); await unfinished;
assert.match(canceled.page.data.result, /超时/);
const stopped = fixture(); stopped.page.stop();
assert.equal(stopped.page.data.reason, '用户停止');
assert.equal(stopped.page.data.result, '尚无结果');
console.log('PASS: round trip, mismatch, unavailable, hidden read, result preservation, zero/multiple targets, interaction gate, auto-start once, timeout, explicit stop.');
const known = fixture({ remembered: true, verified: true });
await known.page.test();
assert.equal(known.state().scans, 0);
assert.match(known.page.data.result, /^通过/);
const unknown = fixture({ remembered: true });
await unknown.page.test();
assert.equal(unknown.state().scans, 1);
for (const [option, stage] of [['scanSyncError', 'S1'], ['scanError', 'S2'], ['listenerError', 'S3'], ['callbackError', 'S5']]) {
  const failing = fixture({ [option]: true });
  await failing.page.test();
  assert(failing.page.data.stage.startsWith(stage), option + ': ' + failing.page.data.stage);
  assert.match(failing.page.data.result, /Error:/);
  assert.equal(failing.page.data.busy, false);
}
console.log('PASS: verified remembered target only, unknown remembered device falls back, scan sync/await/listener/callback failure attribution.');
