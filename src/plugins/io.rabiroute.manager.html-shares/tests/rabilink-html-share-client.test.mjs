import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await fs.readFile(process.env.RABI_TEST_HTML_CLIENT_SOURCE || new URL('../assets/rabilink-html-share-client.mjs', import.meta.url), 'utf8');
const id = '00000000-0000-4000-8000-000000000000';
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

async function viewer(mode) {
  const timers = [], calls = [], status = { textContent: '' }, frame = { hidden: true };
  let finished = false, peerClosed = 0, offerAborted = 0, relayOffers = 0, socketClosed = 0, resolveOffer, now = 0;
  const emit = (target, kind, value) => { const event = new Event(kind); if (value !== undefined) Object.defineProperty(event, 'data', { value }); target.dispatchEvent(event); };
  const header = () => JSON.stringify({ bytes: 1, name: 'fixture.html' });
  const packet = () => JSON.stringify({ aad: `${id}:0:0:1`, nonce: 'AAAAAAAAAAAAAAAA', data: 'AA==' });
  class Channel extends EventTarget {
    send(value) { if (this.stall) return; if (value === 'next') queueMicrotask(() => emit(this, 'message', packet())); }
  }
  class Socket extends Channel {
    constructor(url) { super(); calls.push({ type: 'socket', url }); queueMicrotask(() => { emit(this, 'open'); emit(this, 'message', header()); }); }
    close() { socketClosed++; emit(this, 'close'); }
  }
  class Peer extends EventTarget {
    constructor() { super(); this.iceGatheringState = ['ice', 'late-ice'].includes(mode) ? 'gathering' : 'complete'; this.localDescription = { sdp: 'fixture' }; calls.push({ type: 'peer' }); }
    createDataChannel() { this.channel = new Channel(); this.channel.stall = mode === 'read-stall'; return this.channel; }
    async createOffer() { if (['native-offer', 'late-ice'].includes(mode)) return new Promise(resolve => resolveOffer = resolve); return { type: 'offer', sdp: 'fixture' }; }
    async setLocalDescription() { calls.push({ type: 'local-description' }); }
    async setRemoteDescription() { calls.push({ type: 'remote-description' }); if (mode !== 'open') queueMicrotask(() => { emit(this.channel, 'open'); emit(this.channel, 'message', header()); }); }
    close() { peerClosed++; emit(this.channel, 'close'); }
  }
  class FixtureURL extends URL { static createObjectURL() { return 'blob:fixture'; } }
  const hanging = signal => new Promise((_, reject) => { signal?.addEventListener('abort', () => { offerAborted++; reject(signal.reason); }, { once: true }); });
  const context = vm.createContext({
    location: { pathname: `/share/${id}`, hash: '#' + Buffer.alloc(32).toString('base64url'), href: `https://fixture.invalid/share/${id}` },
    document: { querySelector: selector => selector === '#status' ? status : frame }, history: { replaceState() {} },
    crypto: { subtle: { importKey: async () => ({}), decrypt: async () => Uint8Array.of(1).buffer }, randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    atob, Uint8Array, TextDecoder, TextEncoder, Blob, URL: FixtureURL, URLSearchParams, EventTarget, AbortController, queueMicrotask,
    RTCPeerConnection: Peer, WebSocket: Socket,
    fetch: async (url, options) => {
      calls.push({ type: 'fetch', url });
      if (String(url).endsWith('/connection')) {
        if (mode === 'metadata-http') return hanging(options.signal);
        if (mode === 'metadata-body') return { ok: true, json: () => hanging(options.signal) };
        return { ok: true, json: async () => ({ peerUrls: mode === 'lan' ? ['http://fixture.invalid'] : [], transports: mode.startsWith('relay-') ? ['relay'] : ['lan', 'p2p', 'relay'] }) };
      }
      const value = JSON.parse(options.body);
      if (value.kind === 'relay') {
        relayOffers++;
        if (mode === 'relay-http') return hanging(options.signal);
        if (mode === 'relay-body') return { ok: true, json: () => hanging(options.signal) };
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (mode === 'http' || mode === 'ice') return hanging(options.signal);
      if (mode === 'body') return { ok: true, json: () => hanging(options.signal) };
      if (mode === 'failure') return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ sdp: 'fixture-answer' }) };
    },
    setTimeout: (callback, ms) => { const timer = { callback, ms, due: now + ms, active: true }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.active = false; }, finish: () => { finished = true; }
  });
  const running = vm.runInContext('(async () => { try {\n' + source + '\n} finally { finish(); } })()', context);
  void running.catch(() => {});
  await tick();
  return { timers, calls, status, frame, running,
    expire(ms) { const timer = timers.find(row => row.active && row.ms === ms); assert.ok(timer, `active ${ms}ms timer`); assert.equal(timers.some(row => row.active && row.due < timer.due), false, 'fire deadlines in chronological order'); now = timer.due; timer.active = false; timer.callback(); },
    elapse(ms) { now += ms; assert.equal(timers.some(row => row.active && row.due <= now), false); },
    lateOffer() { resolveOffer?.({ type: 'offer', sdp: 'late' }); },
    get socketClosed() { return socketClosed; },
    get finished() { return finished; }, get peerClosed() { return peerClosed; }, get offerAborted() { return offerAborted; }, get relayOffers() { return relayOffers; }
  };
}

for (const mode of ['http', 'body', 'open', 'ice', 'native-offer']) {
  test(`P2P original connection budget closes ${mode} and reaches Relay once`, async () => {
    const view = await viewer(mode);
    if (mode === 'ice') { view.expire(3000); await tick(); }
    view.expire(10000); await tick();
    assert.equal(view.finished, true);
    assert.equal(view.peerClosed, 1);
    assert.equal(view.relayOffers, 1);
    assert.equal(view.frame.hidden, false);
    assert.equal(view.status.textContent, '已连接：加密中继');
    if (['http', 'body', 'ice'].includes(mode)) assert.equal(view.offerAborted, 1);
    if (mode === 'native-offer') { view.lateOffer(); await tick(); assert.equal(view.calls.some(row => row.type === 'local-description'), false, 'expired native result starts no late handshake'); }
    assert.equal(view.timers.some(row => row.active), false);
  });
}

test('healthy LAN keeps original priority and never requests an offer', async () => {
  const view = await viewer('lan');
  assert.equal(view.finished, true);
  assert.equal(view.calls.some(row => row.type === 'peer'), false);
  assert.equal(view.calls.filter(row => row.type === 'fetch').length, 1);
  assert.equal(view.status.textContent, '已连接：局域网');
});

test('healthy P2P clears the connection deadline before reading', async () => {
  const view = await viewer('success');
  assert.equal(view.finished, true); assert.equal(view.relayOffers, 0);
  assert.equal(view.status.textContent, '已连接：P2P');
  assert.equal(view.timers.some(row => row.active), false);
});

test('ordinary P2P rejection closes once and falls through to Relay once', async () => {
  const view = await viewer('failure');
  assert.equal(view.finished, true); assert.equal(view.peerClosed, 1); assert.equal(view.relayOffers, 1);
  assert.equal(view.status.textContent, '已连接：加密中继');
});

for (const mode of ['metadata-http', 'metadata-body']) {
  test(`original connection budget settles ${mode} with failure UI and no transport retry`, async () => {
    const view = await viewer(mode); view.expire(10000); await tick();
    assert.equal(view.finished, true); assert.equal(view.offerAborted, 1);
    assert.equal(view.frame.hidden, true); assert.match(view.status.textContent, /无法打开分享.*连接超时/);
    assert.equal(view.calls.filter(row => row.type === 'fetch').length, 1);
    assert.equal(view.calls.some(row => row.type === 'peer' || row.type === 'socket'), false);
    assert.equal(view.timers.some(row => row.active), false);
  });
}

for (const mode of ['relay-http', 'relay-body']) {
  test(`original connection budget settles ${mode} and closes its original socket`, async () => {
    const view = await viewer(mode); view.expire(10000); await tick();
    assert.equal(view.finished, true); assert.equal(view.offerAborted, 1);
    assert.equal(view.relayOffers, 1); assert.equal(view.socketClosed, 1);
    assert.equal(view.frame.hidden, true); assert.equal(view.status.textContent, '无法连接到分享电脑，请确认电脑在线后刷新。');
    assert.equal(view.timers.some(row => row.active), false);
  });
}

test('P2P budget includes ICE gathering after a late native offer and cleans its shorter timer', async () => {
  const view = await viewer('late-ice'); view.elapse(9000); view.lateOffer(); await tick();
  view.expire(10000); await tick();
  assert.equal(view.finished, true); assert.equal(view.peerClosed, 1); assert.equal(view.relayOffers, 1);
  assert.equal(view.calls.filter(row => row.type === 'remote-description').length, 0);
  assert.equal(view.calls.filter(row => row.type === 'fetch').length, 2, 'only metadata and Relay offer, no late P2P HTTP');
  assert.equal(view.timers.some(row => row.active), false);
});

test('connected P2P reads retain their original 30000ms idle budget', async () => {
  const view = await viewer('read-stall');
  assert.equal(view.finished, false); assert.equal(view.peerClosed, 0);
  assert.equal(view.timers.some(row => row.active && row.ms === 10000), false);
  view.expire(30000); await tick();
  assert.equal(view.finished, true); assert.equal(view.peerClosed, 1); assert.equal(view.relayOffers, 1);
  assert.equal(view.status.textContent, '已连接：加密中继');
});
