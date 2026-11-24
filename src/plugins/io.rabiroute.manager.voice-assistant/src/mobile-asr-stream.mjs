import { PassThrough } from 'node:stream';

export const mobileAsrSampleRate = 16_000;
export const mobileAsrDurationMs = 5 * 60_000;
export const mobileAsrAudioLimit = mobileAsrSampleRate * 2 * (mobileAsrDurationMs / 1000);
const eventLimit = 64 * 1024;

/** Adapts the existing provider PCM contract to one remote microphone round. */
export function openMobileAsrStream({ request, createAsr, assertCurrent, signal, observationOf }) {
  const output = new PassThrough({ highWaterMark: eventLimit });
  let asr, round, onPcm, stopping, closed = false, total = 0, forwardedSamples = 0, priorFinalSample = 0, remainder, amplitude = 0;

  const detach = () => {
    request.off('data', receive);
    request.off('end', finish);
    request.off('error', fail);
    signal?.removeEventListener('abort', cancel);
  };
  const stop = () => {
    if (stopping) return stopping;
    closed = true;
    detach();
    output.end();
    stopping = Promise.resolve().then(() => round && asr.stop(round));
    return stopping;
  };
  const cancel = () => { void stop().catch(() => {}); };
  const fail = () => {
    if (closed) return;
    // Provider errors may contain transport details. Only the client-safe code is exposed.
    if (!output.writableNeedDrain) output.write('{"type":"error","error":"MOBILE_STREAM_ASR_FAILED"}\n');
    cancel();
  };
  const emit = event => {
    if (closed) return;
    try {
      assertCurrent();
      if (output.writableNeedDrain) throw Error('MOBILE_ASR_EVENT_BACKLOG');
      output.write(Buffer.from(JSON.stringify(event) + '\n'));
    } catch { fail(); }
  };
  function receive(chunk) {
    if (closed) return;
    try {
      assertCurrent();
      total += chunk.length;
      if (total > mobileAsrAudioLimit) throw Error('MOBILE_ASR_AUDIO_LIMIT');
      const bytes = remainder === undefined ? chunk : Buffer.concat([Buffer.from([remainder]), chunk]);
      const aligned = bytes.length - bytes.length % 2;
      remainder = aligned === bytes.length ? undefined : bytes[aligned];
      if (!aligned) return;
      let sum = 0, count = 0;
      for (let index = 0; index < aligned; index += 8) {
        const sample = bytes.readInt16LE(index) / 32768;
        sum += sample * sample;
        count++;
      }
      amplitude = Math.sqrt(sum / count);
      forwardedSamples += aligned / 2;
      onPcm(bytes.subarray(0, aligned));
    } catch { fail(); }
  }
  function finish() {
    if (closed) return;
    if (remainder !== undefined) { fail(); return; }
    Promise.resolve().then(() => asr.finish(round)).catch(fail);
  }
  const recording = {
    async start(_error, options) { onPcm = options.onPcm; },
    amplitude: () => amplitude,
    async dispose() { detach(); },
  };
  signal?.addEventListener('abort', cancel, { once: true });
  void (async () => {
    try {
      signal?.throwIfAborted();
      assertCurrent();
      asr = createAsr({ createRecording: () => recording });
      if (typeof asr.finish !== 'function') throw Error('MOBILE_STREAM_ASR_UNAVAILABLE');
      round = asr.createRound({
        onStart: () => emit({ type: 'ready' }),
        onSpeechStart: () => emit({ type: 'speech-start' }),
        onSpeechEnd: () => emit({ type: 'speech-end' }),
        onInterim: result => {
          if (typeof result.text === 'string' && result.text.trim()) emit({ type: 'interim', text: result.text.slice(0, 16_000) });
        },
        onFinal: result => {
          if (typeof result.text !== 'string' || !result.text.trim()) return;
          const endSample = result.endSample;
          const positioned = Number.isSafeInteger(endSample) && endSample > priorFinalSample && endSample <= forwardedSamples;
          if (positioned) priorFinalSample = endSample;
          emit({ type: 'final', text: result.text.slice(0, 16_000), observation: observationOf(result.additions ?? result),
            ...(positioned ? { endSample } : {}) });
        },
        onEnd: cancel,
        onError: fail,
      });
      await asr.start(round);
      if (closed) return;
      if (!onPcm) throw Error('MOBILE_STREAM_ASR_UNAVAILABLE');
      request.once('error', fail);
      request.once('end', finish);
      if (request.readableEnded) finish();
      else request.on('data', receive);
    } catch { fail(); }
  })();

  return {
    cancel: stop,
    frames: (async function* () {
      try { yield* output; } finally { await stop(); }
    })(),
  };
}
