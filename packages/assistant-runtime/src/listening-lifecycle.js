const fail = code => Object.assign(new Error(code), { code });
const defaultClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };

/** Foreground capture policy. No model, task, transcript storage or playback ownership. */
export function createListeningLifecycle({ asr, clock = defaultClock, canStart = () => true, isActive = () => true,
  onEvent = () => {}, onCleanupError = () => {}, restartDelayMs = 250,
  earlyEndMs = 1000, maxEmptyEnds = 3, startupTimeoutMs = 15000 } = {}) {
  if (!asr || ['createRound', 'start', 'stop'].some(name => typeof asr[name] !== 'function')
      || ['now', 'setTimeout', 'clearTimeout'].some(name => typeof clock[name] !== 'function')
      || [canStart, isActive, onEvent, onCleanupError].some(fn => typeof fn !== 'function')) throw fail('LISTENING_ADAPTER_INVALID');
  for (const value of [restartDelayMs, earlyEndMs, maxEmptyEnds, startupTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw fail('LISTENING_POLICY_INVALID');
  }
  let closed = false, desired = false, owner = null, restart = null, emptyEnds = 0, config = null;
  const report = error => { try { onCleanupError(error); } catch (_) {} };
  const emit = event => { try { onEvent(event); } catch (error) { report(error); } };
  const current = item => !closed && owner === item && !item.finished;
  const clearRestart = () => { if (restart !== null) clock.clearTimeout(restart); restart = null; };
  function clearStartup(item) {
    if (item?.startup !== null && item?.startup !== undefined) clock.clearTimeout(item.startup);
    if (item) item.startup = null;
  }
  function stopResource(item, graceful = false) {
    if (!item?.round) return;
    try {
      const result = asr.stop(item.round, { graceful });
      if (result?.then) Promise.resolve(result).catch(report);
    } catch (error) { report(error); }
  }
  function finish(item, reason, error) {
    if (!current(item)) return;
    item.finished = true; owner = null; clearStartup(item);
    if (reason !== 'end') { desired = false; clearRestart(); stopResource(item); }
    else {
      emptyEnds = !item.hadResult && clock.now() - item.startedAt < earlyEndMs ? emptyEnds + 1 : 0;
      if (emptyEnds >= maxEmptyEnds) { desired = false; reason = 'empty-end-limit'; }
    }
    emit({ type: 'ended', round: item.round, reason, error, emptyEnds });
    // A callback may pause, close, replace or immediately activate capture.
    if (!closed && desired && !owner) requestRestart();
  }
  function markStarted(item) {
    if (!active(item) || !item.round) return false;
    clearStartup(item);
    if (!item.started) { item.started = true; emit({ type: 'listening', round: item.round }); }
    return current(item);
  }
  // Visibility/lifetime is distinct from scheduling policy: a busy model may
  // prevent another round without invalidating the current user's transcript.
  function active(item) {
    if (!current(item)) return false;
    try {
      if (isActive() === true) return current(item);
    } catch (error) { report(error); }
    if (current(item)) pause();
    return false;
  }
  function begin() {
    if (closed || !desired || owner) return owner?.round || null;
    let allowed;
    try { allowed = isActive() === true && canStart() === true; } catch (error) { desired = false; emit({ type: 'ended', round: null, reason: 'guard-error', error, emptyEnds }); return null; }
    if (allowed !== true) return null;
    const item = { round: null, startup: null, finished: false, started: false, hadResult: false, startedAt: clock.now() };
    owner = item;
    const handlers = config.handlers;
    const invoke = (name, args) => {
      if (!active(item)) return;
      try { handlers[name]?.(...args); } catch (error) { finish(item, 'handler-error', error); }
    };
    try {
      if (typeof asr.getCapability === 'function' && asr.getCapability()?.available === false) {
        finish(item, 'unavailable'); return null;
      }
      if (!active(item)) return null;
      item.round = asr.createRound({ continuous: config.continuous, interimResults: config.interimResults,
        onStart: (...args) => { if (markStarted(item)) invoke('onStart', args); },
        onInterim: (...args) => {
          if (!markStarted(item)) return;
          item.hadResult = true; emptyEnds = 0; invoke('onInterim', args);
        },
        onFinal: (...args) => {
          if (!markStarted(item)) return;
          item.hadResult = true; emptyEnds = 0; invoke('onFinal', args);
        },
        onSpeechStart: (...args) => invoke('onSpeechStart', args),
        onSpeechEnd: (...args) => invoke('onSpeechEnd', args),
        onError: error => { if (active(item)) finish(item, 'error', error); },
        onEnd: () => { if (active(item)) finish(item, 'end'); }
      });
      if (!item.round || typeof item.round !== 'object') throw fail('LISTENING_ROUND_INVALID');
    } catch (error) { finish(item, 'create-error', error); return null; }
    // Adapters can call back synchronously while constructing the native round.
    // If that ended ownership, release the returned resource without starting it.
    if (!current(item)) { stopResource(item); return null; }
    emit({ type: 'starting', round: item.round });
    if (!active(item)) return null;
    item.startup = clock.setTimeout(() => { if (active(item)) finish(item, 'start-timeout'); }, config.startupTimeoutMs);
    try {
      const started = asr.start(item.round);
      const dispatched = () => { if (active(item)) emit({ type: 'start-dispatched', round: item.round }); };
      if (started?.then) Promise.resolve(started).then(dispatched, error => { if (active(item)) finish(item, 'start-error', error); });
      else dispatched();
    } catch (error) { finish(item, 'start-error', error); }
    return current(item) ? item.round : null;
  }
  function requestRestart(delayMs = restartDelayMs) {
    clearRestart();
    if (closed || owner) return false;
    if (!desired) { emit({ type: 'activation-required' }); return false; }
    const delay = Math.max(restartDelayMs, Number.isFinite(delayMs) ? delayMs : restartDelayMs);
    restart = clock.setTimeout(() => { restart = null; begin(); }, delay);
    return true;
  }
  function pause({ graceful = false } = {}) {
    desired = false; clearRestart();
    const item = owner; owner = null;
    if (item) { item.finished = true; clearStartup(item); stopResource(item, graceful); }
    emit({ type: 'paused', round: item?.round || null });
  }
  return Object.freeze({
    /** Call synchronously from a real host activation; the adapter enforces permission. */
    activate({ continuous = true, interimResults = true, handlers = {}, startupTimeoutMs: timeout = startupTimeoutMs } = {}) {
      if (closed) throw fail('LISTENING_CLOSED');
      if (!Number.isSafeInteger(timeout) || timeout < 1 || !handlers || typeof handlers !== 'object') throw fail('LISTENING_POLICY_INVALID');
      if (owner) return owner.round;
      clearRestart(); emptyEnds = 0;
      config = { continuous, interimResults, handlers: { ...handlers }, startupTimeoutMs: timeout };
      desired = true;
      return begin();
    },
    requestRestart, clearRestart, pause,
    dispose() { if (closed) return; closed = true; pause(); },
    getState() { return { closed, desired, round: owner?.round || null, starting: Boolean(owner && !owner.started), restartPending: restart !== null, emptyEnds }; }
  });
}
