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
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.onresult = (event) => {
        const text = speechTextFromEvent(event);
        if (!text) return;
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
  const now = typeof options.now === "function" ? options.now : Date.now;
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultId;
  const available = Boolean(synthesis && UtteranceCtor);
  const capability = frozenCapability({
    adapterId,
    kind: "tts",
    available,
    locale,
    supportsCancel: Boolean(synthesis && typeof synthesis.cancel === "function"),
    reason: available ? "" : "AIUI native speechSynthesis is unavailable in this runtime."
  });
  let sequence = 0;

  return Object.freeze({
    adapterId,
    mode: AIUI_NATIVE_VOICE_MODE,
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
