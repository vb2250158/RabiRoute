export const AIUI_NATIVE_VOICE_MODE = "aiui_native";

const VOICE_CAPABILITY_SCHEMA_VERSION = 1;

function normalizedText(value) {
  return String(value || "").trim();
}

function normalizedLocale(value) {
  return normalizedText(value) || "zh-CN";
}

function frozenCapability(input) {
  return Object.freeze({
    schemaVersion: VOICE_CAPABILITY_SCHEMA_VERSION,
    adapterId: input.adapterId,
    kind: input.kind,
    mode: AIUI_NATIVE_VOICE_MODE,
    available: input.available,
    requiresApiKey: false,
    networkFallback: false,
    locale: input.locale,
    locales: Object.freeze([input.locale]),
    supportsPartial: input.kind === "asr" ? false : undefined,
    supportsContinuous: input.kind === "asr" ? false : undefined,
    supportsCancel: input.supportsCancel,
    supportsPlaybackReceipt: input.kind === "tts" ? false : undefined,
    reason: input.reason || ""
  });
}

function errorMessage(error, fallback) {
  if (error instanceof Error && error.message) return error.message;
  const value = normalizedText(error);
  return value || fallback;
}

export class VoiceRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "VoiceRuntimeError";
    this.code = normalizedText(code) || "voice_runtime_error";
    this.adapterId = normalizedText(details.adapterId);
    this.mode = AIUI_NATIVE_VOICE_MODE;
    this.nativeCode = normalizedText(details.nativeCode);
    this.cause = details.cause;
  }
}

function unavailableError(capability) {
  return new VoiceRuntimeError(
    `${capability.kind}_unavailable`,
    capability.reason || `AIUI native ${capability.kind.toUpperCase()} is unavailable.`,
    { adapterId: capability.adapterId }
  );
}

function speechTextFromEvent(event) {
  if (typeof event === "string") return normalizedText(event);
  if (event?.text) return normalizedText(event.text);
  if (event?.transcript) return normalizedText(event.transcript);
  if (event?.detail?.text) return normalizedText(event.detail.text);
  if (event?.detail?.transcript) return normalizedText(event.detail.transcript);
  const results = event?.results;
  if (!results || !results.length) return "";
  const preferredIndex = Number.isInteger(event?.resultIndex) ? event.resultIndex : 0;
  const result = results[preferredIndex] || results[results.length - 1] || results[0];
  const alternative = result?.[0] || result?.item?.(0);
  return normalizedText(alternative?.transcript);
}

function defaultId(prefix, sequence, timestamp) {
  return `${prefix}-${timestamp}-${sequence}`;
}

export function createAiuiAsrInputAdapter(options = {}) {
  const adapterId = normalizedText(options.adapterId) || "aiui-native-asr";
  const locale = normalizedLocale(options.language || options.locale);
  const RecognitionCtor = typeof options.SpeechRecognitionCtor === "function"
    ? options.SpeechRecognitionCtor
    : null;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultId;
  const available = Boolean(RecognitionCtor);
  const capability = frozenCapability({
    adapterId,
    kind: "asr",
    available,
    locale,
    supportsCancel: available,
    reason: available ? "" : "AIUI native SpeechRecognition is unavailable in this runtime."
  });
  let sequence = 0;

  return Object.freeze({
    adapterId,
    mode: AIUI_NATIVE_VOICE_MODE,
    getCapability() {
      return capability;
    },
    createRound(handlers = {}) {
      if (!available) throw unavailableError(capability);
      const recognition = new RecognitionCtor();
      recognition.lang = locale;
      recognition.continuous = handlers.continuous !== undefined
        ? Boolean(handlers.continuous)
        : Boolean(options.continuous);
      recognition.interimResults = handlers.interimResults !== undefined
        ? Boolean(handlers.interimResults)
        : Boolean(options.interimResults);
      const segments = [];
      let finalEmitted = false;

      recognition.onresult = (event) => {
        const results = event?.results;
        if (!results || !results.length) {
          const fallbackText = speechTextFromEvent(event);
          if (!fallbackText) return;
          if (finalEmitted) return;
          finalEmitted = true;
          sequence += 1;
          const capturedAt = Number(now());
          const result = Object.freeze({
            resultId: normalizedText(idFactory("asr", sequence, capturedAt)) || defaultId("asr", sequence, capturedAt),
            text: fallbackText,
            final: true,
            capturedAt,
            adapterId,
            mode: AIUI_NATIVE_VOICE_MODE,
            locale
          });
          handlers.onFinal?.(result, event);
          return;
        }

        segments.length = results.length;
        const startIndex = Number.isInteger(event?.resultIndex) ? event.resultIndex : 0;
        for (let i = startIndex; i < results.length; i++) {
          const item = results[i];
          const alternative = item?.[0] || item?.item?.(0);
          segments[i] = {
            text: alternative?.transcript || "",
            final: item?.isFinal !== false
          };
        }

        const text = segments.map((s) => s?.text || "").join("").trim();
        if (!text) return;

        const isInterimMode = Boolean(recognition.interimResults);
        const hasExplicitInterim = segments.some((s) => s?.final === false);
        const allFinal = segments.length > 0 && !hasExplicitInterim;

        if (!isInterimMode || allFinal) {
          if (finalEmitted) return;
          finalEmitted = true;
          sequence += 1;
          const capturedAt = Number(now());
          const result = Object.freeze({
            resultId: normalizedText(idFactory("asr", sequence, capturedAt)) || defaultId("asr", sequence, capturedAt),
            text,
            final: true,
            capturedAt,
            adapterId,
            mode: AIUI_NATIVE_VOICE_MODE,
            locale
          });
          handlers.onFinal?.(result, event);
        } else {
          handlers.onInterim?.(Object.freeze({
            text,
            final: false,
            adapterId,
            mode: AIUI_NATIVE_VOICE_MODE,
            locale
          }), event);
        }
      };
      recognition.onerror = (event) => {
        const nativeCode = normalizedText(event?.error) || "unknown";
        handlers.onError?.(new VoiceRuntimeError(
          "asr_runtime_error",
          `AIUI native ASR failed: ${nativeCode}`,
          { adapterId, nativeCode }
        ), event);
      };
      recognition.onend = (event) => handlers.onEnd?.(event);
      return recognition;
    },
    start(recognition) {
      if (!available) throw unavailableError(capability);
      if (!recognition || typeof recognition.start !== "function") {
        throw new VoiceRuntimeError("asr_invalid_round", "AIUI native ASR round cannot be started.", { adapterId });
      }
      try {
        recognition.start();
      } catch (error) {
        throw new VoiceRuntimeError(
          "asr_start_failed",
          errorMessage(error, "AIUI native ASR failed to start."),
          { adapterId, cause: error }
        );
      }
    },
    stop(recognition, stopOptions = {}) {
      if (!recognition) return false;
      try {
        if (stopOptions.graceful === true && typeof recognition.stop === "function") recognition.stop();
        else if (typeof recognition.abort === "function") recognition.abort();
        else if (typeof recognition.stop === "function") recognition.stop();
        else return false;
        return true;
      } catch (error) {
        throw new VoiceRuntimeError(
          "asr_stop_failed",
          errorMessage(error, "AIUI native ASR failed to stop."),
          { adapterId, cause: error }
        );
      }
    }
  });
}

export function createAiuiTtsOutputAdapter(options = {}) {
  const adapterId = normalizedText(options.adapterId) || "aiui-native-tts";
  const locale = normalizedLocale(options.language || options.locale);
  const synthesis = options.speechSynthesisApi && typeof options.speechSynthesisApi.speak === "function"
    ? options.speechSynthesisApi
    : null;
  const UtteranceCtor = typeof options.SpeechSynthesisUtteranceCtor === "function"
    ? options.SpeechSynthesisUtteranceCtor
    : null;
  const PlayerCtor = typeof options.SpeechAudioPlayerCtor === "function"
    ? options.SpeechAudioPlayerCtor
    : null;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultId;
  const available = Boolean(synthesis && UtteranceCtor);
  const supportsSynthesize = Boolean(available && typeof synthesis.synthesize === "function" && PlayerCtor);
  const capability = frozenCapability({
    adapterId,
    kind: "tts",
    available,
    locale,
    supportsCancel: Boolean(synthesis && typeof synthesis.cancel === "function"),
    supportsSynthesize,
    reason: available ? "" : "AIUI native speechSynthesis is unavailable in this runtime."
  });
  let sequence = 0;

  return Object.freeze({
    adapterId,
    mode: AIUI_NATIVE_VOICE_MODE,
    supportsSynthesize,
    canSynthesize() {
      return supportsSynthesize;
    },
    getCapability() {
      return capability;
    },
    speak(text, speakOptions = {}) {
      if (!available) throw unavailableError(capability);
      const value = normalizedText(text);
      if (!value) {
        throw new VoiceRuntimeError("tts_empty_text", "AIUI native TTS text is empty.", { adapterId });
      }
      sequence += 1;
      const acceptedAt = Number(now());
      const attemptId = normalizedText(idFactory("tts", sequence, acceptedAt))
        || defaultId("tts", sequence, acceptedAt);
      const messageId = normalizedText(speakOptions.messageId) || attemptId;
      const utterance = new UtteranceCtor(value);
      utterance.voice = speakOptions.voice || options.voice || "female-tianmei";
      utterance.volume = typeof speakOptions.volume === "number" ? speakOptions.volume : 1;
      utterance.lang = locale;
      utterance.onstart = (event) => speakOptions.onStart?.(event);
      utterance.onend = (event) => speakOptions.onEnd?.(event);
      utterance.onerror = (event) => {
        const nativeCode = normalizedText(event?.error) || "unknown";
        speakOptions.onError?.(new VoiceRuntimeError(
          "tts_runtime_error",
          `AIUI native TTS failed: ${nativeCode}`,
          { adapterId, nativeCode }
        ), event);
      };
      const mode = normalizedText(speakOptions.mode) || "enqueue";
      try {
        synthesis.speak(utterance, mode);
      } catch (error) {
        throw new VoiceRuntimeError(
          "tts_start_failed",
          errorMessage(error, "AIUI native TTS failed to start."),
          { adapterId, cause: error }
        );
      }
      const attempt = Object.freeze({
        attemptId,
        messageId,
        accepted: true,
        status: "accepted",
        acceptedAt,
        adapterId,
        mode: AIUI_NATIVE_VOICE_MODE,
        locale,
        playbackReceipt: "not_supported"
      });
      return Object.freeze({ utterance, attempt });
    },
    async synthesize(text, synthesizeOptions = {}) {
      if (!available) throw unavailableError(capability);
      const value = normalizedText(text);
      if (!value) {
        throw new VoiceRuntimeError("tts_empty_text", "AIUI native TTS text is empty.", { adapterId });
      }
      if (!supportsSynthesize) {
        throw new VoiceRuntimeError(
          "tts_synthesize_unsupported",
          "AIUI native speechSynthesis.synthesize is unavailable.",
          { adapterId }
        );
      }
      sequence += 1;
      const acceptedAt = Number(now());
      const attemptId = normalizedText(idFactory("tts", sequence, acceptedAt))
        || defaultId("tts", sequence, acceptedAt);
      const utterance = new UtteranceCtor(value);
      utterance.voice = synthesizeOptions.voice || options.voice || "female-tianmei";
      utterance.volume = typeof synthesizeOptions.volume === "number" ? synthesizeOptions.volume : 1;
      utterance.lang = locale;

      try {
        const task = await synthesis.synthesize(utterance, {
          subtitles: synthesizeOptions.subtitles || "word",
          audio: synthesizeOptions.audio || { preferredFormat: "mp3" }
        });
        const player = new PlayerCtor(task, { trackMode: synthesizeOptions.trackMode || "hidden" });
        if (player.textTrack && typeof player.textTrack.addEventListener === "function") {
          player.textTrack.addEventListener("cuechange", (event) => {
            const cue = (player.textTrack.activeCues && typeof player.textTrack.activeCues.item === "function"
              ? player.textTrack.activeCues.item(0)
              : null) || player.activeCue;
            synthesizeOptions.onCue?.({
              text: cue?.text || "",
              startTime: cue?.startTime,
              endTime: cue?.endTime
            }, event);
          });
        }
        return Object.freeze({ task, player, utterance, attemptId });
      } catch (error) {
        throw new VoiceRuntimeError(
          "tts_synthesize_failed",
          errorMessage(error, "AIUI native TTS synthesize failed."),
          { adapterId, cause: error }
        );
      }
    },
    cancel() {
      if (!synthesis || typeof synthesis.cancel !== "function") return false;
      try {
        synthesis.cancel();
        return true;
      } catch (error) {
        throw new VoiceRuntimeError(
          "tts_cancel_failed",
          errorMessage(error, "AIUI native TTS failed to cancel."),
          { adapterId, cause: error }
        );
      }
    }
  });
}
