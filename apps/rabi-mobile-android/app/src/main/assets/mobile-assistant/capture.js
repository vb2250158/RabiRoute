/** Phone microphone and PCM adapter. ASR restart, user interruption, and playback are SDK-owned. */
export function createPhoneCapture({ transcribe, waveform, phase, mayRecord }) {
  const stop = round => {
    if (round.closed) return;
    round.closed = true;
    round.control.abort();
    if (round.processor) {
      round.processor.onaudioprocess = null;
      round.processor.disconnect();
    }
    round.source?.disconnect();
    round.silentOutput?.disconnect();
    round.stream?.getTracks().forEach(track => track.stop());
    void round.context?.close().catch(() => {});
    round.frames.length = 0;
    round.preRoll.length = 0;
  };

  function submit(round) {
    if (!round.samples || round.closed) return;
    const frames = round.frames;
    const samples = round.samples;
    round.frames = [];
    round.samples = 0;
    if (round.pending >= 4) {
      stop(round);
      round.handlers.onError?.(new Error('MOBILE_ASR_BACKLOG'));
      return;
    }
    round.pending++;
    phase('正在转写');
    round.queue = round.queue.then(async () => {
      if (round.closed) return;
      try {
        const result = await transcribe(encodeWave(frames, samples, round.context.sampleRate), round.control.signal);
        if (!round.closed) round.handlers.onFinal?.(result);
      } catch (error) {
        if (!round.closed) {
          stop(round);
          round.handlers.onError?.(error);
        }
      } finally {
        if (!--round.pending && !round.closed && !round.speaking) phase('正在聆听');
      }
    });
  }

  return {
    adapterId: 'rabi-mobile-pcm',
    createRound(handlers) {
      return {
        handlers, closed: false, frames: [], preRoll: [], samples: 0, silence: 0,
        speaking: false, pending: 0, queue: Promise.resolve(), control: new AbortController(),
      };
    },
    async start(round) {
      try {
        if (!mayRecord()) throw new Error('MOBILE_MICROPHONE_IN_USE');
        round.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
        });
        if (round.closed) {
          round.stream.getTracks().forEach(track => track.stop());
          return;
        }
        round.context = new AudioContext({ sampleRate: 16000 });
        await round.context.resume();
        if (round.closed) return;
        const { sampleRate } = round.context;
        round.source = round.context.createMediaStreamSource(round.stream);
        round.processor = round.context.createScriptProcessor(1024, 1, 1);
        round.silentOutput = round.context.createGain();
        round.silentOutput.gain.value = 0;
        round.source.connect(round.processor);
        round.processor.connect(round.silentOutput);
        round.silentOutput.connect(round.context.destination);
        round.processor.onaudioprocess = event => {
          if (round.closed) return;
          const frame = new Float32Array(event.inputBuffer.getChannelData(0));
          const rms = Math.sqrt(frame.reduce((power, sample) => power + sample ** 2, 0) / frame.length);
          waveform(rms);
          const audible = rms >= 0.025;
          if (!round.speaking && !audible) {
            round.preRoll.push(frame);
            while (round.preRoll.length > Math.ceil(0.2 * sampleRate / frame.length)) round.preRoll.shift();
            return;
          }
          if (!round.speaking) {
            round.speaking = true;
            round.silence = 0;
            round.frames = round.preRoll.splice(0);
            round.samples = round.frames.reduce((sum, item) => sum + item.length, 0);
            phase('正在收音');
            round.handlers.onSpeechStart?.();
            if (round.closed) return;
          }
          round.frames.push(frame);
          round.samples += frame.length;
          round.silence = audible ? 0 : round.silence + frame.length / sampleRate;
          if (round.silence >= 0.6 || round.samples >= sampleRate * 18) {
            round.speaking = false;
            round.handlers.onSpeechEnd?.();
            submit(round);
          }
        };
        for (const track of round.stream.getTracks()) track.addEventListener('ended', () => {
          if (round.closed) return;
          stop(round);
          round.handlers.onEnd?.();
        }, { once: true });
        round.handlers.onStart?.();
        phase('正在聆听');
      } catch (error) {
        if (!round.closed) {
          stop(round);
          round.handlers.onError?.(error);
        }
      }
    },
    stop,
  };
}

export function encodeWave(frames, sampleCount, sampleRate) {
  const samples = new Float32Array(sampleCount);
  let offset = 0;
  for (const frame of frames) {
    samples.set(frame, offset);
    offset += frame.length;
  }
  const targetRate = 16000;
  const step = sampleRate / targetRate;
  const length = Math.floor(sampleCount / step);
  const view = new DataView(new ArrayBuffer(44 + 2 * length));
  const word = (offset, value) => {
    for (const [index, character] of [...value].entries()) view.setUint8(offset + index, character.charCodeAt(0));
  };
  word(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); word(8, 'WAVE');
  word(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true); view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, 'data');
  view.setUint32(40, length * 2, true);
  for (let index = 0; index < length; index++) {
    const start = Math.floor(index * step);
    const end = Math.min(sampleCount, Math.max(start + 1, Math.floor((index + 1) * step)));
    let sum = 0;
    for (let sample = start; sample < end; sample++) sum += samples[sample];
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return new Uint8Array(view.buffer);
}
