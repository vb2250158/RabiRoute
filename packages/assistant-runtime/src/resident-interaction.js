import { createVoiceInteraction } from './voice-interaction.js';

/**
 * Explicit resident lifecycle around the existing voice loop.
 * Services own devices/providers; the caller owns persona, admission and tools.
 * Removing every presenter has no effect on recording or playback.
 */
export function createResidentInteraction({ openServices, onInput, onEvent, onError, voiceOptions = {}, outputEnabled = true, captureStartTimeoutMs = 15000 }) {
  if (typeof openServices !== 'function' || typeof onInput !== 'function') throw new Error('RESIDENT_OPTIONS_INVALID');
  if (!Number.isFinite(captureStartTimeoutMs) || captureStartTimeoutMs < 1 || captureStartTimeoutMs > 300000) throw new Error('RESIDENT_START_TIMEOUT_INVALID');
  let closed = false, generation = 0, current = null, starting = null, cleanupFailure = null;
  let outputCommand = 0;
  let state = { phase: 'stopped', capture: 'stopped', generation: 0, outputEnabled: Boolean(outputEnabled), error: null };
  const observers = new Set(), cleanups = new Set(), starts = new Set();
  const report = error => { try { Promise.resolve(onError?.(error)).catch(() => {}); } catch { /* Diagnostics cannot prevent cleanup. */ } };
  const emit = event => {
    for (const callback of [onEvent, ...observers]) {
      try { Promise.resolve(callback?.(event)).catch(report); } catch (error) { report(error); }
    }
  };
  const publish = patch => { state = { ...state, ...patch }; emit({ type: 'state', state }); };
  const valid = lease => !closed && current === lease && generation === lease.generation;
  const cleanupFailed = error => {
    cleanupFailure = error;
    publish({ phase: closed ? 'disposed' : 'failed', capture: 'failed', error: 'RESIDENT_CLEANUP_UNCONFIRMED' });
    report(error);
  };
  const release = lease => {
    if (!lease) return Promise.resolve();
    if (lease.cleanup) return lease.cleanup;
    lease.abort.abort();
    lease.captureReject?.(new Error('RESIDENT_START_EXPIRED'));
    try { lease.voice?.dispose(); } catch (error) { cleanupFailed(error); }
    const cleanup = Promise.resolve().then(() => lease.services?.dispose()).catch(error => { cleanupFailed(error); throw error; });
    lease.cleanup = cleanup;
    cleanups.add(cleanup);
    void cleanup.then(() => cleanups.delete(cleanup), () => cleanups.delete(cleanup));
    return cleanup;
  };
  const stop = async () => {
    if (closed) return;
    const lease = current;
    current = null; starting = null; generation++;
    publish({ phase: cleanupFailure ? 'failed' : 'stopped', capture: cleanupFailure ? 'failed' : 'stopped', generation });
    await release(lease);
  };
  const activateCapture = lease => {
    if (lease.captureStarting) return lease.captureStarting;
    lease.captureStarted = false; lease.captureDispatched = false; lease.captureFailure = null;
    let resolveCapture;
    const capture = new Promise((resolve, reject) => { resolveCapture = resolve; lease.captureReject = reject; });
    lease.confirmCapture = () => {
      if (lease.captureStarted && lease.captureDispatched && !lease.captureFailure) resolveCapture();
    };
    void capture.catch(() => {});
    const task = Promise.resolve().then(async () => {
      if (!valid(lease)) throw new Error('RESIDENT_START_EXPIRED');
      const timer = setTimeout(() => lease.captureReject(new Error('RESIDENT_CAPTURE_START_TIMEOUT')), captureStartTimeoutMs);
      try {
        const round = lease.voice.activate({ continuous: true });
        if (round === null) throw lease.captureFailure ?? new Error('RESIDENT_CAPTURE_BLOCKED');
        await capture;
        if (lease.captureFailure) throw lease.captureFailure;
        if (!valid(lease)) throw new Error('RESIDENT_START_EXPIRED');
      } finally { clearTimeout(timer); }
    });
    lease.captureStarting = task;
    void task.then(() => { lease.captureStarting = null; }, () => { lease.captureStarting = null; });
    return task;
  };
  const start = () => {
    if (closed) return Promise.reject(new Error('RESIDENT_CLOSED'));
    if (cleanupFailure) return Promise.reject(new Error('RESIDENT_CLEANUP_UNCONFIRMED'));
    if (state.phase === 'running') return Promise.resolve(state);
    if (starting) return starting;
    const lease = { generation: ++generation, abort: new AbortController(), services: null, voice: null, cleanup: null };
    current = lease;
    const priorStarts = [...starts];
    let resolveStart, rejectStart;
    const task = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    starting = task;
    starts.add(task);
    const settled = () => { starts.delete(task); if (starting === task) starting = null; };
    void task.then(settled, settled);
    publish({ phase: 'starting', capture: 'starting', generation, error: null });
    void (async () => {
      try {
        // A new generation cannot acquire the device while a former one is releasing it.
        await Promise.allSettled(priorStarts);
        await Promise.all([...cleanups]);
        if (cleanupFailure) throw new Error('RESIDENT_CLEANUP_UNCONFIRMED');
        if (!valid(lease)) throw new Error('RESIDENT_START_EXPIRED');
        const services = await openServices({ signal: lease.abort.signal, generation: lease.generation });
        if (!services?.runtime || typeof services.dispose !== 'function') {
          try { await services?.dispose?.(); } catch (error) { cleanupFailed(error); throw error; }
          throw new Error('RESIDENT_SERVICES_INVALID');
        }
        if (!valid(lease)) {
          try { await services.dispose(); } catch (error) { cleanupFailed(error); throw error; }
          throw new Error('RESIDENT_START_EXPIRED');
        }
        lease.services = services;
        lease.voice = createVoiceInteraction({
          ...voiceOptions, runtime: services.runtime, outputEnabled: state.outputEnabled,
          isActive: () => valid(lease),
          onInput: input => { if (valid(lease)) return onInput(input); },
          onEvent: event => {
            if (!valid(lease)) return;
            if (event.type === 'listening') {
              const listening = event.event;
              if (listening.type === 'listening') { lease.captureStarted = true; publish({ capture: 'listening' }); lease.confirmCapture?.(); }
              else if (listening.type === 'start-dispatched') { lease.captureDispatched = true; lease.confirmCapture?.(); }
              else if (listening.type === 'starting') publish({ capture: 'starting' });
              else if (listening.type === 'ended' && listening.reason !== 'end') {
                const error = listening.error ?? new Error('RESIDENT_CAPTURE_' + listening.reason);
                lease.captureFailure = error;
                lease.captureReject(error);
                if (state.phase === 'running') {
                  current = null;
                  publish({ phase: 'failed', capture: 'failed', error: error instanceof Error ? error.message : String(error) });
                  void release(lease).catch(report);
                }
              } else if (listening.type === 'ended' || listening.type === 'paused') publish({ capture: 'stopped' });
            }
            emit({ type: 'voice', event });
          },
          onError: error => {
            if (!valid(lease)) return;
            publish({ error: error instanceof Error ? error.message : String(error) });
            report(error);
          },
        });
        await activateCapture(lease);
        publish({ phase: 'running' });
        return state;
      } catch (error) {
        if (valid(lease)) {
          current = null;
          publish({ phase: 'failed', capture: 'failed', error: error instanceof Error ? error.message : String(error) });
          report(error);
        }
        await release(lease);
        throw error;
      }
    })().then(resolveStart, rejectStart);
    return task;
  };
  return {
    start, stop,
    pauseCapture() {
      if (!current || state.phase !== 'running' || current.captureStarting) throw new Error('RESIDENT_CAPTURE_NOT_READY');
      current.voice.pauseListening();
    },
    async resumeCapture() {
      const lease = current;
      if (!lease || state.phase !== 'running') throw new Error('RESIDENT_CAPTURE_NOT_READY');
      if (state.capture === 'listening') return state;
      try { await activateCapture(lease); return state; }
      catch (error) {
        if (valid(lease)) {
          current = null;
          publish({ phase: 'failed', capture: 'failed', error: error instanceof Error ? error.message : String(error) });
          await release(lease);
        }
        throw error;
      }
    },
    getState: () => state,
    subscribe(callback) { if (closed) return () => {}; observers.add(callback); return () => observers.delete(callback); },
    setOutputEnabled(enabled) {
      if (closed) throw new Error('RESIDENT_CLOSED');
      const allowed = Boolean(enabled);
      const command = ++outputCommand;
      // Voice cancellation emits synchronous callbacks; they may issue a newer
      // output command. Commit first and never publish an obsolete outer write.
      state = { ...state, outputEnabled: allowed };
      current?.voice?.setOutputEnabled(allowed);
      if (command === outputCommand) emit({ type: 'state', state });
    },
    beginResponse(options) { return current?.voice?.beginResponse(options) ?? null; },
    interruptSpeech(reason) { return current?.voice?.interruptSpeech(reason) ?? false; },
    async dispose() {
      if (closed) return;
      const lease = current; current = null; starting = null; closed = true; generation++;
      publish({ phase: 'disposed', capture: 'stopped', generation });
      observers.clear();
      await release(lease);
      await Promise.allSettled([...starts]);
      await Promise.all([...cleanups]);
    },
  };
}
