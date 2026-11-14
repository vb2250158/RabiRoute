import { encodeAsr, decodeFrame } from './volcano-codec.mjs';
import { openSpeechSocket } from './speech-socket.mjs';
import { encodeVolcanoAsrRequest } from './speech-catalog.mjs';

/** Real-time 16k mono PCM input, with local onset for immediate barge-in. */
export function createVolcanoAsr({ createRecording, settings, connection, connect = openSpeechSocket }) {
  const rounds = new WeakMap();
  const stop = state => {
    if (!state) return Promise.resolve();
    if (state.disposal) return state.disposal;
    state.closed = true; state.abort.abort(); clearInterval(state.monitor);
    state.disposal = (async () => { await Promise.all([state.recording.dispose(), state.socket?.close()]); await state.chain; })();
    return state.disposal;
  };
  return {
    createRound(handlers) {
      const round = {}, state = { handlers, recording: createRecording(), closed: false, abort: new AbortController(), chain: Promise.resolve(), pending: 0, pcm: Buffer.alloc(0), speaking: false, committedEnd: -1, interim: '' };
      rounds.set(round, state); return round;
    },
    async start(round) {
      const state = rounds.get(round);
      if (!state || state.closed) throw Error('DESKTOP_ASR_ROUND_INVALID');
      const fail = error => { if (!state.closed) { state.handlers.onError?.(error); void stop(state).catch(() => {}); } };
      try {
        const config = settings(), options = await connection();
        state.abort.signal.throwIfAborted();
        state.socket = await connect({ ...options, signal: state.abort.signal, onError: fail,
          onMessage(bytes) {
            if (state.closed) return;
            const frame = decodeFrame(bytes), result = frame.data?.result;
            if (result) {
              const utterances = result.utterances || [];
              for (const item of utterances) {
                if (item.definite === true && typeof item.text === 'string' && item.text.trim() && Number.isFinite(item.end_time) && item.end_time > state.committedEnd) {
                  state.committedEnd = item.end_time;
                  state.handlers.onFinal?.({ text: item.text, additions: item.additions, startTime:item.start_time,endTime:item.end_time });
                }
              }
              const partial = utterances.filter(item => item.definite !== true).map(item => item.text || '').join('');
              if (partial && partial !== state.interim) state.handlers.onInterim?.({ text: partial });
              state.interim = partial;
            }
            if (frame.last) { state.handlers.onEnd?.(); void stop(state).catch(fail); }
          },
        });
        if (state.closed) { await state.socket.close(); return; }
        await state.socket.send(encodeAsr({ user: { uid: 'desktop-assistant' }, audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
          request: encodeVolcanoAsrRequest(config) }));
        await state.recording.start(fail, { onPcm(bytes) {
          if (state.closed) return;
          state.pcm = Buffer.concat([state.pcm, bytes]);
          // Two 64ms capture chunks form one 128ms protocol frame.
          while (state.pcm.length >= 4096) {
            const chunk = state.pcm.subarray(0, 4096); state.pcm = state.pcm.subarray(4096);
            if (++state.pending > 12) { fail(Error('SPEECH_SEND_BACKLOG')); return; }
            state.chain = state.chain.then(() => { if (!state.closed) return state.socket.send(encodeAsr(chunk, { audio: true })); }).catch(fail).finally(() => { state.pending--; });
          }
        } });
        if (state.closed) return;
        state.handlers.onStart?.();
        state.monitor = setInterval(() => {
          if (state.closed) return;
          if (state.recording.amplitude() >= config.silenceThreshold) {
            state.quietSince = undefined;
            if (!state.speaking) { state.speaking = true; state.handlers.onSpeechStart?.(); }
          } else if (state.speaking) {
            state.quietSince ??= performance.now();
            if (performance.now() - state.quietSince >= config.silenceDurationMs) { state.speaking = false; state.handlers.onSpeechEnd?.(); }
          }
        }, config.sampleMs);
      } catch (error) { await stop(state); throw error; }
    },
    stop(round) { return stop(rounds.get(round)); },
  };
}
