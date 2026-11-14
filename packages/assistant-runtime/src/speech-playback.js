const failure = code => Object.assign(new Error(code), { code });
const defaultClock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };

/** A watchdog estimate, never evidence that audio was played or heard. */
export function estimateSpeechDurationMs(text) {
  const value = String(text || '');
  const han = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const words = (value.replace(/[\u3400-\u9fff]/g, ' ').match(/[0-9A-Za-z]+/g) || []).length;
  const punctuation = (value.match(/[，。！？,.!?;:]/g) || []).length;
  return Math.max(1200, Math.min(90000, 800 + han * 280 + words * 420 + punctuation * 180));
}

/** Serial, independently cancellable output. This layer owns no ASR, model or backend task. */
export function createSpeechPlayback({ tts, releaseSpeech, clock = defaultClock,
  isActive = () => true, onEvent = () => {}, onCleanupError = () => {},
  estimateDurationMs = estimateSpeechDurationMs, synthesisTimeoutMs = () => 30000,
  playbackTimeoutMs = fallback => fallback } = {}) {
  if (typeof tts?.synthesize !== 'function'
      || [clock.setTimeout, clock.clearTimeout, isActive, onEvent, onCleanupError,
        estimateDurationMs, synthesisTimeoutMs, playbackTimeoutMs].some(fn => typeof fn !== 'function')
      || (releaseSpeech !== undefined && typeof releaseSpeech !== 'function')) throw failure('SPEECH_ADAPTER_INVALID');
  let closed = false, owner = null, queue = [], sequence = 0;
  const report = error => { try { onCleanupError(error); } catch (_) {} };
  const attempt = action => { try { const result = action(); if (result?.then) Promise.resolve(result).catch(report); } catch (error) { report(error); } };
  const emit = event => { try { onEvent(event); } catch (error) { report(error); } };
  const current = item => !closed && owner === item && !item.finished;
  const event = (type, item, extra = {}) => emit({ type, id: item?.id, text: item?.text || '', ...extra });
  function clearTimer(item, key) {
    if (item[key] !== null) clock.clearTimeout(item[key]);
    item[key] = null;
  }
  function release(output, abort, controller) {
    let handled = false;
    try { handled = releaseSpeech?.(output, { abort })?.handled === true; } catch (error) { report(error); }
    if (handled) return;
    if (abort) {
      attempt(() => controller?.abort());
      attempt(() => output.task?.abort?.());
      attempt(() => output.player?.stop?.());
    }
    attempt(() => output.player?.destroy?.());
  }
  function retire(item, abort) {
    item.finished = true;
    clearTimer(item, 'timer'); clearTimer(item, 'readyTimer');
    for (const unbind of item.unbind.splice(0)) attempt(unbind);
    release(item.job || (item.pending ? { task: item.pending } : {}), abort, item.controller);
  }
  function cancel() {
    queue = [];
    const item = owner; owner = null;
    if (item) retire(item, true);
    event('cancelled', item);
  }
  function active(item) {
    if (!current(item)) return false;
    try { if (isActive() === true) return current(item); } catch (error) { report(error); }
    if (current(item)) cancel();
    return false;
  }
  function finish(item, error) {
    if (!active(item)) return;
    owner = null; retire(item, Boolean(error));
    event(error ? 'error' : 'ended', item, error ? { error } : {});
    pump();
  }
  function deadline(item, delay, code) {
    if (!Number.isFinite(delay) || delay <= 0) throw failure('SPEECH_TIMEOUT_INVALID');
    clearTimer(item, 'timer');
    item.timer = clock.setTimeout(() => finish(item, failure(code)), delay);
  }
  function bind(item, target, name, callback) {
    if (typeof target?.addEventListener !== 'function') return false;
    target.addEventListener(name, callback, { once: true });
    if (typeof target.removeEventListener === 'function') item.unbind.push(() => target.removeEventListener(name, callback));
    return true;
  }
  function attach(item, job) {
    if (!active(item)) { release(job || {}, true); return; }
    item.job = job;
    if (!job?.task || !job?.player || typeof job.player.play !== 'function') { finish(item, failure('SPEECH_JOB_INVALID')); return; }
    if (item.streaming && (typeof job.input?.append !== 'function' || typeof job.input?.finish !== 'function')) { finish(item, failure('SPEECH_STREAM_JOB_INVALID')); return; }
    const { task, player } = job;
    const audio = player.audioPlayer;
    try {
      deadline(item, item.streaming && !item.inputFinished ? 30000 : playbackTimeoutMs(estimateDurationMs(item.text) + 3000), 'SPEECH_PLAYBACK_TIMEOUT');
      const ended = () => finish(item);
      const errored = error => finish(item, error || failure('SPEECH_PLAYER_ERROR'));
      if (typeof audio?.onEnded === 'function') {
        audio.onEnded(ended); audio.onError?.(errored);
      } else { bind(item, audio, 'ended', ended); bind(item, audio, 'error', errored); }
      if (task.finished?.then) Promise.resolve(task.finished).then(info => {
        if (!active(item)) return;
        const measured = Number(info?.duration) * 1000;
        const duration = Number.isFinite(measured) && measured > 0 ? measured : estimateDurationMs(item.text);
        deadline(item, playbackTimeoutMs(duration + 800), 'SPEECH_PLAYBACK_TIMEOUT');
      }).catch(errored);
      const play = () => {
        if (!active(item) || item.playRequested) return;
        item.playRequested = true;
        try {
          const result = player.play();
          if (result?.then) Promise.resolve(result).catch(errored);
          if (current(item)) event('play-requested', item);
        } catch (error) { errored(error); }
      };
      if (!active(item)) return;
      if (typeof audio?.onCanplay === 'function') audio.onCanplay(play);
      else if (task.state === 'running' && typeof task.addEventListener === 'function') {
        // Web players need their first chunk loaded before play().
        bind(item, task, 'chunk', () => {
          if (active(item)) item.readyTimer = clock.setTimeout(() => { item.readyTimer = null; play(); }, 0);
        });
      } else play();
      if (item.streaming) flushInput(item);
    } catch (error) { finish(item, error); }
  }
  function pump() {
    if (closed || owner) return;
    const item = queue.shift();
    if (!item) { event('idle', null); return; }
    owner = item;
    if (!active(item)) return;
    event('synthesizing', item);
    if (!active(item)) return;
    try {
      deadline(item, synthesisTimeoutMs(), 'SPEECH_SYNTHESIS_TIMEOUT');
      const synthesize = item.streaming ? options => tts.openStream(options) : options => tts.synthesize(item.text, options);
      item.pending = synthesize({ ...item.options, signal: item.controller.signal,
        onCue: cue => { if (active(item)) event('cue', item, { cue }); }
      });
      Promise.resolve(item.pending).then(job => attach(item, job), error => finish(item, error));
    } catch (error) { finish(item, error); }
  }
  function flushInput(item) {
    if (!item.job || !active(item)) return;
    for (const delta of item.inputBuffer.splice(0)) {
      item.inputChain = item.inputChain.then(() => { if (active(item)) return item.job.input.append(delta); });
    }
    if (item.inputFinished && !item.finishDispatched) {
      item.finishDispatched = true;
      item.inputChain = item.inputChain.then(() => { if (active(item)) return item.job.input.finish(); });
    }
    void item.inputChain.catch(error => finish(item, error));
  }
  return Object.freeze({
    /** One text stream maps to one provider session; ordinary providers keep speak(). */
    beginStream(options = {}) {
      if (closed) throw failure('SPEECH_PLAYBACK_CLOSED');
      if (typeof tts.openStream !== 'function') throw failure('SPEECH_STREAM_UNAVAILABLE');
      if (options.signal !== undefined || options.onCue !== undefined) throw failure('SPEECH_CALLBACK_OWNERSHIP_INVALID');
      const item = { id: ++sequence, text: '', options: { ...options }, streaming: true,
        inputBuffer: [], inputFinished: false, finishDispatched: false, inputChain: Promise.resolve(),
        controller: new AbortController(), job: null, pending: null, timer: null, readyTimer: null,
        finished: false, playRequested: false, unbind: [] };
      queue.push(item); pump();
      return Object.freeze({
        append(delta) {
          if (item.finished || item.inputFinished || closed) return false;
          if (typeof delta !== 'string' || item.text.length + delta.length > 16000) throw failure('SPEECH_STREAM_TEXT_LIMIT');
          if (!delta) return true;
          item.text += delta; item.inputBuffer.push(delta);
          if (item.job && active(item)) deadline(item, 30000, 'SPEECH_STREAM_INPUT_TIMEOUT');
          flushInput(item); return true;
        },
        finish() {
          if (item.finished || item.inputFinished || closed) return false;
          item.inputFinished = true;
          if (item.job && active(item)) deadline(item, playbackTimeoutMs(estimateDurationMs(item.text) + 3000), 'SPEECH_PLAYBACK_TIMEOUT');
          flushInput(item); return true;
        },
      });
    },
    speak(text, { mode = 'enqueue', ...options } = {}) {
      if (closed) throw failure('SPEECH_PLAYBACK_CLOSED');
      if (typeof text !== 'string' || !text.trim()) return false;
      if (!['enqueue', 'immediate'].includes(mode)) throw failure('SPEECH_MODE_INVALID');
      if (options.signal !== undefined || options.onCue !== undefined) throw failure('SPEECH_CALLBACK_OWNERSHIP_INVALID');
      let available;
      try { available = typeof tts.canSynthesize === 'function' ? tts.canSynthesize() : tts.supportsSynthesize !== false; }
      catch (error) { event('error', null, { error }); return false; }
      if (!available) { event('unavailable', null); return false; }
      if (mode === 'immediate') cancel();
      const item = { id: ++sequence, text: text.trim(), options: { ...options, ...(options.audio ? { audio: { ...options.audio } } : {}) },
        controller: new AbortController(), job: null, pending: null, timer: null, readyTimer: null,
        finished: false, playRequested: false, unbind: [] };
      queue.push(item); pump();
      return true;
    },
    cancel,
    dispose() { if (closed) return; closed = true; cancel(); },
    getState() { return { closed, active: Boolean(owner), queued: queue.length, text: owner?.text || '',
      task: owner?.job?.task || owner?.pending || null, player: owner?.job?.player || null }; }
  });
}
