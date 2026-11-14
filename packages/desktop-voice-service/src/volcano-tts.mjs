import { randomUUID } from 'node:crypto';
import { encodeTts, decodeFrame } from './volcano-codec.mjs';
import { openSpeechSocket } from './speech-socket.mjs';

/** One reply owns one bidirectional session; no punctuation splitting or full-audio buffering. */
export async function openVolcanoTts({ endpoint, headers, voice, requestParams, signal, onAudio, connect = openSpeechSocket }) {
  if (!voice) throw Error('SPEECH_TTS_MODEL_REQUIRED');
  const sessionId = randomUUID(), waits = new Map();
  let socket, closed = false, completed = false, cancelled = false, inputEnded = false, sessionRequested = false, closing, chars = 0, samples = 0;
  let resolveFinished, rejectFinished;
  const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
  void finished.catch(() => {});
  const rejectWaits = error => { for (const waiter of waits.values()) { clearTimeout(waiter.timer); waiter.reject(error); } waits.clear(); };
  const fail = error => { if (closed) return; rejectFinished(error); rejectWaits(error); void close(); };
  const wait = (event, timeout = 15000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waits.delete(event); reject(Error('SPEECH_PROVIDER_EVENT_TIMEOUT')); }, timeout);
    waits.set(event, { resolve, reject, timer });
  });
  const exchange = async (event, expected, payload, timeout) => {
    if (closed && event !== 101 && event !== 2) throw Error('SPEECH_STREAM_CLOSED');
    const response = wait(expected, timeout);
    try { await socket.send(encodeTts(event, sessionId, payload)); await response; }
    catch (error) { rejectWaits(error); await response.catch(() => {}); throw error; }
  };
  const abort = () => { void close().catch(() => {}); };
  function close() {
    if (closing) return closing;
    cancelled = !completed; closed = true; signal?.removeEventListener('abort', abort);
    rejectWaits(Error('SPEECH_STREAM_CLOSED'));
    closing = (async () => {
      // Audio callbacks are fenced before asking the provider to cancel.
      if (socket && sessionRequested && !completed) {
        try { await exchange(101, 151, {}, 1000); } catch {}
      }
      rejectWaits(Error('SPEECH_STREAM_CLOSED'));
      await socket?.close();
      if (cancelled) rejectFinished(Error('SPEECH_STREAM_CANCELLED'));
    })();
    return closing;
  }
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    socket = await connect({ endpoint, headers, signal, handshakeSignalOnly: true, onError: fail,
      async onMessage(bytes) {
        const frame = decodeFrame(bytes, { tts: true });
        if ([51, 153].includes(frame.event)) { fail(Error('SPEECH_PROVIDER_SESSION_FAILED')); return; }
        if (frame.event >= 100 && frame.id !== sessionId) throw Error('SPEECH_SESSION_MISMATCH');
        const waiter = waits.get(frame.event);
        if (waiter) { waits.delete(frame.event); clearTimeout(waiter.timer); waiter.resolve(frame); }
        if (closed || completed) return;
        if (frame.type === 11 && frame.event === 352) {
          if (frame.payload.length % 2) throw Error('SPEECH_PCM_INVALID');
          samples += frame.payload.length / 2;
          await onAudio(frame.payload);
        } else if (frame.event === 152) {
          if (!inputEnded) throw Error('SPEECH_SESSION_ENDED_EARLY');
          completed = true; resolveFinished({ duration: samples / (requestParams?.audio_params?.sample_rate||24000) });
          // FinishConnection is separate from FinishSession, and no next session overlaps.
          void exchange(2, 52, {}, 1000).catch(() => {}).finally(() => close());
        }
      },
    });
    if (closed) { await socket.close(); throw Error('SPEECH_STREAM_CLOSED'); }
    signal?.throwIfAborted();
    await exchange(1, 50, {});
    if (closed || signal?.aborted) throw Error('SPEECH_STREAM_CLOSED');
    sessionRequested = true;
    await exchange(100, 150, { event: 100, namespace: 'BidirectionalTTS', req_params: requestParams||{ speaker: voice, audio_params: { format: 'pcm', sample_rate: 24000 } } });
    if (closed) throw Error('SPEECH_STREAM_CLOSED');
    return {
      finished,
      async append(text) {
        if (closed || inputEnded) throw Error('SPEECH_STREAM_CLOSED');
        if (typeof text !== 'string' || chars + text.length > 16000) throw Error('SPEECH_TEXT_INVALID');
        chars += text.length;
        if (text) await socket.send(encodeTts(200, sessionId, { event: 200, namespace: 'BidirectionalTTS', req_params: { text } }));
      },
      async finish() { if (closed || inputEnded) return; inputEnded = true; await socket.send(encodeTts(102, sessionId, {})); },
      close,
    };
  } catch (error) { rejectFinished(error); await close(); throw error; }
}
