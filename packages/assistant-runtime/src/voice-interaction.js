import { createListeningLifecycle } from './listening-lifecycle.js';
import { createSpeechPlayback } from './speech-playback.js';

const owners = new WeakMap();
const fail = code => Object.assign(new Error(code), { code });
const sentenceBoundary = /[。！？!?；;\n؟؛۔।॥]|\.(?=\s)/g;

/** A period at the end of a stream chunk may be part of a decimal or URL. */
export function splitSpeechText(text, flush = false) {
  const parts = [];
  let start = 0;
  sentenceBoundary.lastIndex = 0;
  for (let match; (match = sentenceBoundary.exec(text));) {
    const end = match.index + match[0].length;
    const part = text.slice(start, end).trim();
    if (part) parts.push(part);
    start = end;
  }
  const rest = text.slice(start);
  if (flush && rest.trim()) parts.push(rest.trim());
  return { parts, rest: flush ? '' : rest };
}

/** Common voice policy for glasses, browser, desktop GUI and optional pet views.
 * The injected runtime owns native resources. The assistant callback owns user
 * turns/personas/tools. Interrupting voice never cancels that callback or model.
 * Each runtime has one interaction owner, regardless of the number of views. */
export function createVoiceInteraction({ runtime, onInput, onEvent = () => {}, onError = () => {},
  textOf = result => result?.text, acceptTranscript = () => true, isActive = () => true,
  listening: listeningOptions = {}, playback: playbackOptions = {}, maxResponseChars = 16000,
  outputEnabled = true } = {}) {
  if (!runtime || typeof runtime !== 'object' || !runtime.asr || !runtime.tts
      || typeof runtime.releaseSpeech !== 'function' || typeof runtime.getState !== 'function'
      || [onInput, onEvent, onError, textOf, acceptTranscript, isActive].some(fn => typeof fn !== 'function')) {
    throw fail('VOICE_INTERACTION_ADAPTER_INVALID');
  }
  if (!Number.isSafeInteger(maxResponseChars) || maxResponseChars < 1) throw fail('VOICE_RESPONSE_LIMIT_INVALID');
  if (typeof outputEnabled !== 'boolean') throw fail('VOICE_OUTPUT_ENABLED_INVALID');
  if (owners.has(runtime)) throw fail('VOICE_INTERACTION_ALREADY_ATTACHED');
  const owner = {}, subscribers = new Set(), responses = new Set();
  let closed = false, enabled = true, epoch = 0, responseSequence = 0, transcript = '', foreground = null;
  const report = error => { try { onError(error); } catch (_) { /* Diagnostics cannot own voice resources. */ } };
  const notify = (callback, value) => {
    try { const result = callback(value); if (result?.then) Promise.resolve(result).catch(report); }
    catch (error) { report(error); }
  };
  const emit = event => {
    notify(onEvent, event);
    for (const callback of [...subscribers]) notify(callback, event);
  };
  const active = () => !closed && enabled && isActive() === true;
  let playback, listening;
  const interruptSpeech = (reason = 'manual') => {
    if (closed) return false;
    for (const response of responses) { response.suppressed = true; response.buffer = ''; }
    if (foreground) foreground.suppressed = true;
    playback.cancel();
    emit({ type: 'speech-interrupted', reason });
    return true;
  };
  const deliver = (text, source, result) => {
    if (!active() || typeof text !== 'string' || !text.trim()) return false;
    const value = text.trim();
    if (acceptTranscript(value, 'final') !== true) return false;
    interruptSpeech(source);
    transcript = value;
    const input = Object.freeze({ text: value, source, result });
    emit({ type: 'input', input });
    if (!active()) return false;
    notify(onInput, input);
    return true; // Admitted to the callback, not a durable or completed task receipt.
  };
  playback = createSpeechPlayback({ ...playbackOptions, tts: runtime.tts,
    releaseSpeech: (output, options) => runtime.releaseSpeech(output, options),
    isActive: () => active() && outputEnabled, onCleanupError: report,
    onEvent: event => { if (event.type === 'error' && event.error) report(event.error); emit({ type: 'playback', event }); notify(playbackOptions.onEvent || (() => {}), event); }
  });
  listening = createListeningLifecycle({ ...listeningOptions, asr: runtime.asr,
    isActive: active, onCleanupError: report,
    onEvent: event => { emit({ type: 'listening', event }); notify(listeningOptions.onEvent || (() => {}), event); }
  });
  owners.set(runtime, owner);
  function retireResponses() {
    epoch++;
    for (const response of responses) { response.retired = true; response.buffer = ''; }
    responses.clear();
  }
  function beginResponse({ id = 'response-' + (++responseSequence), speech = {} } = {}) {
    if (closed) throw fail('VOICE_INTERACTION_CLOSED');
    if (typeof id !== 'string' || !id || id.length > 256) throw fail('VOICE_RESPONSE_ID_INVALID');
    if (!active()) throw fail('VOICE_INTERACTION_INACTIVE');
    if ([...responses].some(response => response.id === id)) throw fail('VOICE_RESPONSE_ID_CONFLICT');
    if (responses.size >= 16) throw fail('VOICE_RESPONSE_CAPACITY');
    // A new reply may supersede presentation without cancelling any old work.
    interruptSpeech('response-replaced');
    if (!active()) throw fail('VOICE_INTERACTION_INACTIVE');
    const response = { id, epoch, text: '', buffer: '', finished: false, retired: false,
      suppressed: !outputEnabled,
      speech: { ...speech, ...(speech.audio ? { audio: { ...speech.audio } } : {}) } };
    responses.add(response); foreground = response;
    const current = () => active() && !response.retired && response.epoch === epoch && !response.finished;
    const announce = () => emit({ type: 'response', id, text: response.text, suppressed: response.suppressed,
      foreground: foreground === response, finished: response.finished });
    const speak = flush => {
      if (runtime.getState().inputPending) { response.suppressed = true; response.buffer = ''; }
      if (!outputEnabled || response.suppressed || foreground !== response) return;
      if (typeof runtime.tts.openStream === 'function') {
        const delta = response.buffer; response.buffer = '';
        if (delta) {
          response.stream ||= playback.beginStream(response.speech);
          response.stream.append(delta);
        }
        if (flush) response.stream?.finish();
        return;
      }
      const chunks = splitSpeechText(response.buffer, flush); response.buffer = chunks.rest;
      for (const part of chunks.parts) {
        // Output events may synchronously trigger input, hide or disposal.
        if (!current() || response.suppressed || foreground !== response) break;
        playback.speak(part, { ...response.speech, mode: 'enqueue' });
      }
    };
    announce();
    return Object.freeze({ id,
      append(delta) {
        if (!current()) return false;
        if (typeof delta !== 'string') throw fail('VOICE_RESPONSE_TEXT_INVALID');
        if (response.text.length + delta.length > maxResponseChars) {
          response.suppressed = true; response.buffer = '';
          if (foreground === response) playback.cancel();
          throw fail('VOICE_RESPONSE_LIMIT');
        }
        response.text += delta;
        if (!response.suppressed) response.buffer += delta;
        announce();
        if (current()) speak(false);
        return true;
      },
      finish({ speak: flush = true } = {}) {
        if (!current()) return false;
        if (flush) speak(true);
        else {
          response.suppressed = true; response.buffer = '';
          if (foreground === response) playback.cancel();
        }
        response.finished = true; responses.delete(response); announce(); return true;
      },
      getState() { return { id, text: response.text, suppressed: response.suppressed, finished: response.finished, retired: response.retired }; }
    });
  }
  return Object.freeze({ listening, playback, beginResponse, interruptSpeech,
    activate(options = {}) {
      if (closed) throw fail('VOICE_INTERACTION_CLOSED');
      enabled = true;
      const callbacks = options.handlers || {};
      return listening.activate({ ...options, handlers: { ...callbacks,
        onSpeechStart(...args) { interruptSpeech('speech-onset'); callbacks.onSpeechStart?.(...args); },
        onInterim(result, ...args) {
          const text = String(textOf(result) || '').trim();
          if (!text || acceptTranscript(text, 'interim') !== true) return;
          interruptSpeech('interim'); transcript = text;
          emit({ type: 'transcript', text, final: false }); callbacks.onInterim?.(result, ...args);
        },
        onFinal(result, ...args) {
          if (deliver(textOf(result), 'speech', result)) callbacks.onFinal?.(result, ...args);
        }
      } });
    },
    submitText(text) { return deliver(text, 'text'); },
    /** Persistent audio gate, independent of capture, text projection and model work.
     * Re-enabling allows only new responses; muted tokens never replay their tail. */
    setOutputEnabled(value) {
      if (typeof value !== 'boolean') throw fail('VOICE_OUTPUT_ENABLED_INVALID');
      if (closed || outputEnabled === value) return;
      outputEnabled = value; // Fence reentrant player/host callbacks before cancellation.
      if (!value) interruptSpeech('output-disabled');
    },
    /** Pause capture only. Explicitly interruptSpeech to stop output as well. */
    pauseListening(options) { listening.pause(options); },
    suspend() {
      if (closed) return;
      enabled = false; retireResponses(); listening.pause(); playback.cancel();
    },
    subscribe(callback) {
      if (closed) throw fail('VOICE_INTERACTION_CLOSED');
      if (typeof callback !== 'function') throw fail('VOICE_SUBSCRIBER_INVALID');
      subscribers.add(callback); return () => subscribers.delete(callback);
    },
    getState() { return { closed, enabled, outputEnabled, transcript, inputPending: runtime.getState().inputPending,
      listening: listening.getState(), playback: playback.getState(),
      response: foreground ? { id: foreground.id, text: foreground.text, suppressed: foreground.suppressed } : null }; },
    dispose() {
      if (closed) return;
      closed = true; enabled = false; retireResponses(); listening.dispose(); playback.dispose(); subscribers.clear();
      if (owners.get(runtime) === owner) owners.delete(runtime);
    }
  });
}
