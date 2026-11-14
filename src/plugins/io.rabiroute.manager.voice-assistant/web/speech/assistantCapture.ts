import type { AsrHandlers } from "../../../../../packages/assistant-runtime/src/aiui-runtime.js";

type Transcript = { text: string };
type Round = {
  handlers: AsrHandlers<Transcript>; stopped: boolean; stream?: MediaStream; context?: AudioContext;
  source?: MediaStreamAudioSourceNode; processor?: ScriptProcessorNode; sink?: GainNode;
  frames: Float32Array[]; preRoll: Float32Array[]; speaking: boolean; silence: number; samples: number;
  uploads: number; queue: Promise<void>;
  controller: AbortController;
};

/** PCM capture and utterance segmentation only. Listening restart and barge-in policy live in the shared SDK. */
export function createAssistantCapture(options: {
  transcribe(blob: Blob, signal: AbortSignal): Promise<Transcript>;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createContext?: () => AudioContext;
}) {
  function stop(round: Round) {
    if (round.stopped) return;
    round.stopped = true;
    round.controller.abort();
    if (round.processor) { round.processor.onaudioprocess = null; round.processor.disconnect(); }
    round.source?.disconnect(); round.sink?.disconnect();
    round.stream?.getTracks().forEach(track => track.stop());
    void round.context?.close().catch(() => {});
    round.frames = []; round.preRoll = [];
  }
  function flush(round: Round) {
    if (!round.frames.length || round.stopped) return;
    if (round.uploads >= 4) {
      stop(round); round.handlers.onError?.(new Error("ASR_BACKLOG_FULL")); return;
    }
    const blob = encodePcmWave(round.frames, round.context!.sampleRate);
    round.frames = []; round.samples = 0; round.uploads++;
    // Keep microphone capture active while ASR runs. Order transcripts by capture order, not HTTP latency.
    round.queue = round.queue.then(async () => {
      if (round.stopped) return;
      try {
        const result = await options.transcribe(blob, round.controller.signal);
        if (!round.stopped) round.handlers.onFinal?.(result);
      } catch (error) {
        if (!round.stopped) { stop(round); round.handlers.onError?.(error); }
      } finally {
        round.uploads--;
        // Another utterance may already await recognition. An empty interim is transport state,
        // never text to send to the assistant, and keeps that pending input ahead of TTS.
        if (!round.stopped && round.uploads > 0) round.handlers.onInterim?.({ text: "" });
      }
    });
  }
  return Object.freeze({
    adapterId: "rabi.browser-pcm",
    createRound(handlers: AsrHandlers<Transcript> = {}): Round {
      return { handlers, stopped: false, frames: [], preRoll: [], speaking: false, silence: 0,
        samples: 0, uploads: 0, queue: Promise.resolve(), controller: new AbortController() };
    },
    async start(round: Round) {
      try {
        const stream = await (options.getUserMedia ?? (constraints => navigator.mediaDevices.getUserMedia(constraints)))({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false
        });
        if (round.stopped) { stream.getTracks().forEach(track => track.stop()); return; }
        round.stream = stream;
        const context = (options.createContext ?? (() => new AudioContext({ sampleRate: 16000 })))();
        round.context = context;
        await context.resume();
        if (round.stopped) return;
        round.source = context.createMediaStreamSource(stream);
        round.processor = context.createScriptProcessor(1024, 1, 1);
        round.sink = context.createGain(); round.sink.gain.value = 0;
        round.source.connect(round.processor); round.processor.connect(round.sink); round.sink.connect(context.destination);
        round.processor.onaudioprocess = event => {
          if (round.stopped) return;
          const frame = new Float32Array(event.inputBuffer.getChannelData(0));
          const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length);
          const voiced = rms >= 0.025;
          if (!round.speaking && voiced) {
            round.speaking = true; round.frames = round.preRoll.splice(0);
            round.samples = round.frames.reduce((sum, item) => sum + item.length, 0);
            round.handlers.onSpeechStart?.();
            if (round.stopped) return;
          }
          if (!round.speaking) {
            round.preRoll.push(frame);
            while (round.preRoll.length > Math.ceil(context.sampleRate * 0.2 / frame.length)) round.preRoll.shift();
            return;
          }
          round.frames.push(frame); round.samples += frame.length;
          round.silence = voiced ? 0 : round.silence + frame.length / context.sampleRate;
          if (round.silence >= 0.6) {
            round.speaking = false; round.silence = 0;
            round.handlers.onSpeechEnd?.(); flush(round);
          } else if (round.samples >= context.sampleRate * 20) flush(round);
        };
        for (const track of stream.getTracks()) track.addEventListener("ended", () => {
          if (!round.stopped) { stop(round); round.handlers.onError?.(new Error("MICROPHONE_DISCONNECTED")); }
        }, { once: true });
        round.handlers.onStart?.();
      } catch (error) {
        if (!round.stopped) { stop(round); round.handlers.onError?.(error); }
      }
    },
    stop
  });
}

export function encodePcmWave(frames: readonly Float32Array[], sampleRate: number): Blob {
  const samples = frames.reduce((sum, frame) => sum + frame.length, 0);
  const buffer = new ArrayBuffer(44 + samples * 2), view = new DataView(buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const frame of frames) for (const value of frame) {
    const sample = Math.max(-1, Math.min(1, value));
    view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true); offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}
