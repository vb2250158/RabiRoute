import { createAssistantSession } from './assistant-session.js';
import { createAssistantConversation } from './conversation-runtime.js';

const failure = code => Object.assign(new Error(code), { code });
const resource = value => value !== null && (typeof value === 'object' || typeof value === 'function');

/** Page-scoped ownership, with independently replaceable model sessions.
 * Adapters supply host APIs; this module never chooses a provider or backend. */
export function createAiuiAssistantRuntime({ asr, tts, session: initialSession, onCleanupError = () => {}, onInputStateChange = () => {} } = {}) {
  if (typeof asr?.createRound !== 'function' || typeof asr.start !== 'function' || typeof asr.stop !== 'function'
      || typeof tts?.synthesize !== 'function' || typeof onCleanupError !== 'function'
      || typeof onInputStateChange !== 'function') throw failure('AIUI_ADAPTERS_REQUIRED');
  let closed = false, recognition = null, speech = null, session = null, conversation = null;
  let inputPending = false;
  const rounds = new WeakMap(), speechOwners = new WeakMap();
  const assertOpen = () => { if (closed) throw failure('AIUI_RUNTIME_CLOSED'); };
  const currentRound = owner => !closed && recognition === owner && !owner.stopped;
  function syncInputState() {
    const value = Boolean(!closed && recognition && !recognition.stopped
      && (recognition.speaking || recognition.pendingTranscript));
    if (conversation && !conversation.getState().closed) conversation.setListening(value);
    if (value === inputPending) return;
    inputPending = value;
    attempt(() => onInputStateChange(value), []);
  }
  function report(error, errors) {
    errors.push(error);
    try { onCleanupError(error); } catch (_) { /* Diagnostics cannot interrupt remaining cleanup. */ }
  }
  function attempt(action, errors) {
    try {
      const result = action();
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(error => report(error, errors));
    } catch (error) { report(error, errors); }
  }
  function stopRound(owner, options = {}) {
    if (!owner || owner.stopped) return false;
    owner.stopped = true;
    if (recognition === owner) {
      recognition = null;
      syncInputState();
    }
    return asr.stop(owner.round, options);
  }
  function releaseOutput(owner, abort = true) {
    if (!owner || owner.released) return [];
    owner.released = true;
    if (speech === owner) speech = null;
    owner.externalSignal?.removeEventListener('abort', owner.externalAbort);
    const errors = [];
    // Cancel a pending synthesis even when a caller reports playback completion.
    if (abort || !owner.job) {
      owner.reject(failure('AIUI_SPEECH_CANCELLED'));
      attempt(() => owner.controller.abort(), errors);
      attempt(() => owner.job?.task?.abort?.(), errors);
      attempt(() => owner.job?.player?.stop?.(), errors);
    }
    attempt(() => owner.job?.player?.destroy?.(), errors);
    return errors;
  }
  function releaseLate(job) {
    const errors = [];
    attempt(() => job?.task?.abort?.(), errors);
    attempt(() => job?.player?.destroy?.(), errors);
    return errors;
  }
  const asrAdapter = Object.freeze({
    ...asr,
    getCapability: typeof asr.getCapability === 'function' ? () => asr.getCapability() : undefined,
    createRound(handlers = {}) {
      assertOpen();
      stopRound(recognition);
      const owner = { round: null, stopped: false, speaking: false, pendingTranscript: false };
      const callbacks = { ...handlers };
      callbacks.onStart = (...args) => { if (currentRound(owner)) handlers.onStart?.(...args); };
      callbacks.onInterim = (...args) => {
        if (!currentRound(owner)) return;
        owner.pendingTranscript = true;
        syncInputState();
        handlers.onInterim?.(...args);
      };
      callbacks.onFinal = (...args) => {
        if (!currentRound(owner)) return;
        owner.pendingTranscript = false;
        // Enqueue the user's input before releasing waiting background work.
        try { handlers.onFinal?.(...args); }
        finally { syncInputState(); }
      };
      callbacks.onSpeechStart = (...args) => {
        if (!currentRound(owner)) return;
        owner.speaking = true;
        owner.pendingTranscript = true;
        syncInputState();
        const output = speech;
        // Let the UI invalidate its playback generation/queue before native
        // cancellation can synchronously invoke player callbacks.
        try { handlers.onSpeechStart?.(...args); }
        finally { releaseOutput(output); }
      };
      for (const name of ['onSpeechEnd', 'onError']) {
        callbacks[name] = (...args) => {
          if (!currentRound(owner)) return;
          owner.speaking = false;
          // Silence can precede the final transcript. Only an error terminates
          // that pending input without a transcript or a round-end receipt.
          if (name === 'onError') owner.pendingTranscript = false;
          try { handlers[name]?.(...args); }
          finally { syncInputState(); }
        };
      }
      callbacks.onEnd = (...args) => {
        if (!currentRound(owner)) return;
        recognition = null; owner.stopped = true;
        try { handlers.onEnd?.(...args); }
        finally { syncInputState(); }
      };
      owner.round = asr.createRound(callbacks);
      if (!resource(owner.round)) throw failure('AIUI_ASR_ROUND_INVALID');
      rounds.set(owner.round, owner);
      recognition = owner;
      return owner.round;
    },
    start(round) {
      assertOpen();
      const owner = resource(round) && rounds.get(round);
      if (!owner || !currentRound(owner)) throw failure('AIUI_ASR_ROUND_INACTIVE');
      const failed = error => { attempt(() => stopRound(owner), []); throw error; };
      try {
        const result = asr.start(round);
        return result && typeof result.then === 'function' ? Promise.resolve(result).catch(failed) : result;
      } catch (error) { return failed(error); }
    },
    stop(round, options) { return stopRound(resource(round) && rounds.get(round), options); }
  });
  function acquireSpeech(invoke, options = {}) {
      assertOpen();
      if (!options || typeof options !== 'object') throw failure('AIUI_SPEECH_INPUT_INVALID');
      if (options.signal?.aborted) return Promise.reject(failure('AIUI_SPEECH_CANCELLED'));
      releaseOutput(speech);
      const owner = { controller: new AbortController(), released: false, job: null,
        externalSignal: options.signal, externalAbort: null, reject: null };
      const cancellation = new Promise((_, reject) => { owner.reject = reject; });
      cancellation.catch(() => {});
      speech = owner;
      owner.externalAbort = () => { releaseOutput(owner); };
      options.signal?.addEventListener('abort', owner.externalAbort, { once: true });
      if (options.signal?.aborted) owner.externalAbort();
      const incoming = Promise.resolve().then(() => {
        if (owner.released || closed) throw failure('AIUI_SPEECH_CANCELLED');
        return invoke({ ...options, signal: owner.controller.signal,
          onCue: (...args) => { if (!owner.released && !closed) options.onCue?.(...args); }
        });
      }).then(job => {
        if (owner.released || closed) { releaseLate(job); throw failure('AIUI_SPEECH_CANCELLED'); }
        if (!resource(job?.task) || !resource(job?.player)) {
          releaseLate(job); throw failure('AIUI_TTS_JOB_INVALID');
        }
        owner.job = job;
        speechOwners.set(job.task, owner); speechOwners.set(job.player, owner);
        return job;
      });
      const result = Promise.race([incoming, cancellation]).catch(error => { releaseOutput(owner); throw error; });
      speechOwners.set(result, owner);
      return result;
  }
  const ttsAdapter = Object.freeze({
    ...tts,
    getCapability: typeof tts.getCapability === 'function' ? () => tts.getCapability() : undefined,
    canSynthesize: typeof tts.canSynthesize === 'function' ? () => tts.canSynthesize() : undefined,
    openStream: typeof tts.openStream === 'function' ? options => acquireSpeech(value => tts.openStream(value), options) : undefined,
    synthesize(text, options = {}) {
      if (typeof text !== 'string' || !text.trim()) throw failure('AIUI_SPEECH_INPUT_INVALID');
      return acquireSpeech(value => tts.synthesize(text, value), options);
    }
  });
  function createSession(options) {
    assertOpen();
    // Validate the replacement before giving up the current session.
    const replacement = createAssistantSession(options);
    conversation?.dispose();
    conversation = null;
    session?.dispose();
    session = replacement;
    return replacement;
  }
  function createConversation(options) {
    assertOpen();
    if (!session || conversation) throw failure('AIUI_CONVERSATION_SESSION_REQUIRED');
    conversation = createAssistantConversation({ ...options, session });
    syncInputState();
    return conversation;
  }
  if (initialSession) createSession(initialSession);
  return Object.freeze({
    asr: asrAdapter, tts: ttsAdapter, createSession, createConversation,
    get session() { return session; },
    get conversation() { return conversation; },
    interruptSpeech() { return releaseOutput(speech); },
    /** Retire only the identified output, never a newer utterance. Returns
     * handled=false for resources not acquired through this runtime. */
    releaseSpeech({ task, player } = {}, { abort = false } = {}) {
      const taskOwner = resource(task) && speechOwners.get(task);
      const playerOwner = resource(player) && speechOwners.get(player);
      if (taskOwner && playerOwner && taskOwner !== playerOwner) throw failure('AIUI_SPEECH_OWNER_MISMATCH');
      const owner = taskOwner || playerOwner;
      return { handled: Boolean(owner), errors: releaseOutput(owner, abort) };
    },
    suspendVoice() {
      const errors = releaseOutput(speech);
      attempt(() => stopRound(recognition), errors);
      return errors;
    },
    dispose() {
      if (closed) return [];
      closed = true;
      const errors = releaseOutput(speech);
      attempt(() => stopRound(recognition), errors);
      attempt(() => conversation?.dispose(), errors);
      conversation = null;
      attempt(() => session?.dispose(), errors);
      session = null;
      return errors;
    },
    getState() { return { closed, inputPending, hasRecognitionRound: Boolean(recognition), hasSpeechOutput: Boolean(speech), session: session?.getState() || null }; }
  });
}
