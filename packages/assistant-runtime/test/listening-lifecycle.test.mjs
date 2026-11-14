import test from 'node:test';
import assert from 'node:assert/strict';
import { createListeningLifecycle } from '../src/listening-lifecycle.js';

function fixture(overrides = () => ({})) {
  let now = 0, next = 0;
  const timers = new Map(), rounds = [], events = [];
  const clock = { now: () => now, setTimeout(fn, ms) { const id = next++; timers.set(id, { at: now + ms, fn }); return id; }, clearTimeout(id) { timers.delete(id); } };
  const advance = ms => { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } };
  const asr = { createRound(handlers) { const round = { handlers, starts: 0, stops: 0 }; rounds.push(round); return round; },
    start(round) { round.starts++; round.handlers.onStart(); }, stop(round) { round.stops++; round.handlers.onEnd(); } };
  const lifecycle = createListeningLifecycle({ asr, clock, onEvent: event => events.push(event), ...overrides(asr, events) });
  return { lifecycle, rounds, events, advance, timers };
}
const setup = (overrides = () => ({})) => fixture(overrides);

test('capture needs activation, starts synchronously and restarts on normal end with configurable delay', () => {
  const f = setup(() => ({ restartDelayMs: 220 }));
  f.lifecycle.requestRestart(); f.advance(1000); assert.equal(f.rounds.length, 0);
  const round = f.lifecycle.activate(); assert.equal(round.starts, 1);
  round.handlers.onFinal({ text: 'first' }); round.handlers.onEnd();
  f.advance(219); assert.equal(f.rounds.length, 1);
  f.advance(1); assert.equal(f.rounds.length, 2);
  assert.equal(f.lifecycle.getState().desired, true);
});

test('three rapid empty rounds stop; explicit reactivation resets the budget', () => {
  const f = setup(); f.lifecycle.activate();
  for (let i = 0; i < 3; i++) { f.rounds[i].handlers.onEnd(); f.advance(250); }
  assert.equal(f.rounds.length, 3); assert.equal(f.lifecycle.getState().desired, false);
  assert.equal(f.events.at(-1).reason, 'empty-end-limit');
  f.lifecycle.activate(); assert.equal(f.rounds.length, 4); assert.equal(f.lifecycle.getState().emptyEnds, 0);
});

test('startup deadline is cancelled by either real start or interim input; silence is not final input', () => {
  const f = setup(asr => { asr.start = round => { round.starts++; }; return { startupTimeoutMs: 50 }; });
  let finals = 0;
  const round = f.lifecycle.activate({ handlers: { onFinal() { finals++; } } });
  round.handlers.onInterim({ text: 'unfinished' }); round.handlers.onSpeechEnd(); f.advance(80);
  assert.equal(f.lifecycle.getState().round, round); assert.equal(finals, 0);
  f.lifecycle.pause(); const second = f.lifecycle.activate(); f.advance(50);
  assert.equal(second.stops, 1); assert.equal(f.lifecycle.getState().desired, false);
  assert.equal(f.events.at(-1).reason, 'start-timeout');
});

test('pause clears a timer with id zero and a queued restart; hidden guard prevents capture', () => {
  let visible = true;
  const f = setup(asr => { asr.start = () => {}; return { canStart: () => visible }; });
  const first = f.lifecycle.activate(); f.lifecycle.pause(); assert.equal(f.timers.size, 0);
  visible = false; f.lifecycle.activate(); f.advance(1000); assert.equal(f.rounds.length, 1);
  visible = true; f.lifecycle.requestRestart(); f.advance(250); assert.equal(f.rounds.length, 2);
  f.rounds[1].handlers.onEnd(); f.lifecycle.pause(); f.advance(1000);
  assert.equal(f.rounds.length, 2); assert.equal(first.stops, 1);
});

test('late callbacks and async start rejection cannot stop a replacement', async () => {
  let reject;
  const f = setup(asr => { asr.start = round => round === f.rounds[0] ? new Promise((_, r) => { reject = r; }) : undefined; return {}; });
  const seen = []; const first = f.lifecycle.activate({ handlers: { onFinal: r => seen.push(r.text) } });
  f.lifecycle.pause(); const second = f.lifecycle.activate({ handlers: { onFinal: r => seen.push(r.text) } });
  reject(Error('old start')); await Promise.resolve(); await Promise.resolve();
  first.handlers.onFinal({ text: 'late' }); first.handlers.onError(Error('late')); first.handlers.onEnd();
  second.handlers.onFinal({ text: 'current' });
  assert.deepEqual(seen, ['current']); assert.equal(second.stops, 0); assert.equal(f.lifecycle.getState().round, second);
});

test('host rejection, construction failure and callback failure stop without automatic permission retries', () => {
  for (const failure of ['create', 'start', 'event', 'handler']) {
    const f = setup(asr => {
      if (failure === 'create') asr.createRound = () => { throw Error('create'); };
      if (failure === 'start') asr.start = () => { throw Error('start'); };
      return {};
    });
    const round = f.lifecycle.activate({ handlers: { onFinal() { throw Error('handler'); } } });
    if (failure === 'event') round.handlers.onError({ code: 'not-allowed' });
    if (failure === 'handler') round.handlers.onFinal({ text: 'input' });
    f.advance(10000); assert.equal(f.lifecycle.getState().desired, false);
    assert.equal(f.lifecycle.getState().round, null); assert.equal(f.timers.size, 0);
  }
});

test('callbacks may pause or dispose during startup and cannot start stale capture', () => {
  let lifecycle;
  const f = setup(() => ({ onEvent(event) { if (event.type === 'starting') lifecycle.pause(); } }));
  lifecycle = f.lifecycle; lifecycle.activate();
  assert.equal(f.rounds[0].starts, 0); assert.equal(f.rounds[0].stops, 1); assert.equal(f.timers.size, 0);
  lifecycle.dispose(); assert.throws(() => lifecycle.activate(), /LISTENING_CLOSED/);
});

test('hidden or destroyed owners retire capture and ignore every late native callback', () => {
  for (const event of ['onStart', 'onSpeechStart', 'onSpeechEnd', 'onInterim', 'onFinal', 'onError', 'onEnd']) {
    let visible = true, delivered = 0;
    const f = setup(() => ({ isActive: () => visible }));
    const handlers = Object.fromEntries(['onStart', 'onSpeechStart', 'onSpeechEnd', 'onInterim', 'onFinal'].map(name => [name, () => { delivered++; }]));
    const round = f.lifecycle.activate({ handlers });
    delivered = 0; visible = false;
    round.handlers[event]({ text: 'late' });
    round.handlers.onFinal({ text: 'later' }); f.advance(20000);
    assert.equal(delivered, 0, event); assert.equal(round.stops, 1, event);
    assert.equal(f.lifecycle.getState().desired, false); assert.equal(f.lifecycle.getState().round, null);
    assert.equal(f.events.at(-1).type, 'paused'); assert.equal(f.rounds.length, 1);
  }
});

test('scheduling guard does not discard current input while the model becomes busy', () => {
  let busy = false; const seen = [];
  const f = setup(() => ({ canStart: () => !busy }));
  const round = f.lifecycle.activate({ handlers: { onFinal: result => seen.push(result.text) } });
  busy = true; round.handlers.onFinal({ text: 'complete words' }); round.handlers.onEnd(); f.advance(250);
  assert.deepEqual(seen, ['complete words']); assert.equal(f.rounds.length, 1);
  busy = false; f.lifecycle.requestRestart(); f.advance(250); assert.equal(f.rounds.length, 2);
});

test('synchronous construction callbacks cannot leak or start a retired native resource', () => {
  for (const event of ['onError', 'onEnd']) {
    const f = setup(asr => {
      const create = asr.createRound;
      asr.createRound = handlers => { const round = create(handlers); handlers[event](Error('during construction')); return round; };
      return {};
    });
    assert.equal(f.lifecycle.activate(), null);
    assert.equal(f.rounds[0].starts, 0); assert.equal(f.rounds[0].stops, 1);
    f.lifecycle.pause(); assert.equal(f.timers.size, 0);
  }
});
