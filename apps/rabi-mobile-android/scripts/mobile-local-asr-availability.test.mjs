import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalAsrAvailabilityRefresh } from '../app/src/main/assets/mobile-assistant/local-asr-availability.js';

function fixture(read) {
  let now = 0, sequence = 0;
  const timers = new Map(), updates = [];
  const clock = {
    setTimeout(run, delay) { const id = ++sequence; timers.set(id, {run, at:now + delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const refresh = createLocalAsrAvailabilityRefresh({read, clock, onAvailable: (...args) => updates.push(args)});
  return {refresh, timers, updates, get now() { return now; }, next() {
    const [id, timer] = [...timers].sort((a,b) => a[1].at - b[1].at)[0];
    timers.delete(id);
    now = timer.at;
    return timer.run();
  }};
}

const checking = {passiveAsrStatus:'checking'};
const ready = {passiveModel:'fireredasr2/fireredasr2-aed',dictionary:null};
const state = (sessionId, mobileAudio) => ({sessionId,hostSettings:{mobileAudio}});

test('cold local capability becomes usable from the next bounded same-session read', async () => {
  let reads = 0;
  const f = fixture(async () => state('original', reads++ === 0 ? checking : ready));
  f.refresh.sync('original', undefined);
  assert.equal(f.timers.size, 0, 'older Managers do not cause polling');
  f.refresh.sync('original', 'checking');
  f.refresh.sync('original', 'checking');
  await f.next();
  assert.deepEqual(f.updates, []);
  await f.next();
  assert.deepEqual(f.updates, [['original',ready]]);
  assert.equal(reads, 2);
  assert.equal(f.timers.size, 0);
});

test('closing the screen or switching session ignores the original probe even if it completes', async () => {
  let reply, aborted = false;
  const f = fixture(signal => new Promise(resolve => {
    reply = resolve;
    signal.addEventListener('abort', () => {aborted = true;}, {once:true});
  }));
  f.refresh.sync('old', 'checking');
  const inflight = f.next();
  f.refresh.sync('new', 'checking');
  assert.equal(aborted, true);
  reply(state('old',ready));
  await inflight;
  assert.deepEqual(f.updates, []);
  f.refresh.stop();
  assert.equal(f.timers.size, 0);
});

test('four pending reads expire at 18 seconds and do not advertise a model', async () => {
  let reads = 0;
  const f = fixture(async () => { reads++; return state('original',checking); });
  f.refresh.sync('original', 'checking');
  while (f.timers.size) await f.next();
  assert.equal(f.now, 18_000);
  assert.equal(reads, 4);
  assert.deepEqual(f.updates, [['original',undefined]]);
});
