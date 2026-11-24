const conversationalAudio = { echoCancellation:true, noiseSuppression:true, autoGainControl:true };
const keywordAudio = { echoCancellation:false, noiseSuppression:false, autoGainControl:false };
const keywordReplaySeconds = 4;
const pendingWakeReplaySeconds = 35;
const useConversationalAudio = policy => policy.kind !== 'wake' || !policy.kws;

/** Phone PCM capture. The shared voice SDK owns recognition rounds, interruption and audio output. */
export function createPhoneCapture({
  transcribe, waveform, phase, mayRecord, getPolicy = () => ({ kind: 'utterance' }),
  openStream, openWake, matchWake, onWake, onFallback, onWakeFallback,
}) {
  let current;
  const stop = round => {
    if (round.closed) return;
    round.closed = true;
    round.control.abort();
    round.streamSession?.close();
    round.wakeSession?.close();
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
    round.replay.length = 0;
    round.recentSpeech.length = 0;
    round.backup = undefined;
    if (current === round) current = undefined;
  };

  function setAudioProcessing(round, enabled) {
    if (round.audioProcessing === enabled) return;
    round.audioProcessing = enabled;
    const track = round.stream?.getAudioTracks?.()[0];
    if (!track?.applyConstraints) return;
    round.processingJob = (round.processingJob ?? Promise.resolve()).then(async () => {
      if (round.closed || round.audioProcessing !== enabled) return;
      try { await track.applyConstraints(enabled ? conversationalAudio : keywordAudio); }
      catch { /* Keep the live track if the device does not support changing its processing. */ }
    });
  }

  function finishInput(round, result) {
    if (round.restoreAfterFinal && typeof result?.text === 'string' && result.text.trim()) {
      round.restoreAfterFinal = false;
      if (round.preRoll.length) limitPreRoll(round, round.preRoll.at(-1).length);
      setAudioProcessing(round, true);
    }
    round.handlers.onFinal?.(result);
  }

  function started(round) {
    if (!round.started) round.handlers.onStart?.();
    round.started = true;
    phase(round.policy.kind === 'wake' ? '等待唤醒词' : '正在聆听');
  }

  function streamFailed(round, error) {
    if (round.closed) return;
    const backup = round.backup;
    if (!backup) {
      stop(round);
      round.handlers.onError?.(error);
      return;
    }
    round.policy = { kind:'utterance', local:true };
    round.backup = undefined;
    round.streamSession?.close();
    round.streamSession = undefined;
    started(round);
    onFallback?.();
    for (const segment of backup.segments) transcribeSegment(round, segment);
    if (round.speaking && round.lastAudible > round.confirmedThrough) phase('正在收音');
  }

  function acceptStreamFinal(round, backup, origin, event) {
    if (!backup) return true;
    const endSample = event.endSample;
    if (Number.isSafeInteger(endSample) && endSample > 0 && endSample <= round.position - origin) {
      const end = origin + endSample;
      if (end <= backup.lastTimedEnd) return false;
      backup.lastTimedEnd = end;
      round.confirmedThrough = Math.max(round.confirmedThrough, end);
    } else {
      // Legacy providers do not give a PCM watermark. Match the oldest complete local utterance first.
      const first = backup.segments[0];
      round.confirmedThrough = Math.max(round.confirmedThrough,
        first ? first.end : round.speaking ? round.lastAudible : round.position);
    }
    backup.segments = backup.segments.filter(segment => segment.lastAudible > round.confirmedThrough);
    return true;
  }

  function startStream(round, buffered) {
    try {
      const policy = round.policy;
      const backup = round.backup;
      const first = buffered[0];
      const origin = first ? first.after - first.frame.length : round.position;
      const active = () => !round.closed && round.policy === policy;
      let awaitingFinal = false;
      phase('正在连接实时识别');
      if (backup) for (const { frame, after } of buffered) captureLocal(round, frame, after);
      if (round.context.sampleRate !== 16000) throw new Error('MOBILE_STREAM_SAMPLE_RATE_UNAVAILABLE');
      const session = openStream({
        receive(event) {
          if (!active()) return;
          switch (event.type) {
            case 'ready': started(round); break;
            case 'speech-start':
              awaitingFinal = true;
              round.handlers.onSpeechStart?.();
              break;
            case 'speech-end':
              round.handlers.onSpeechEnd?.();
              break;
            case 'interim':
              if (typeof event.text !== 'string' || !event.text.trim()) return;
              awaitingFinal = true;
              round.handlers.onInterim?.(event);
              break;
            case 'final':
              if (typeof event.text !== 'string' || !event.text.trim() || !acceptStreamFinal(round, backup, origin, event)) return;
              awaitingFinal = false;
              finishInput(round, event);
              break;
          }
        },
        error(error) { if (active()) streamFailed(round, error); },
        end() {
          if (!active()) return;
          if (backup || awaitingFinal) streamFailed(round, new Error('MOBILE_STREAM_ENDED'));
          else { stop(round); round.handlers.onEnd?.(); }
        },
      });
      if (!active()) {
        session.close();
        return;
      }
      round.streamSession = session;
      for (const { frame } of buffered) {
        if (!session.write(frame)) throw new Error('MOBILE_STREAM_BACKLOG');
      }
    } catch (error) {
      streamFailed(round, error);
    }
  }

  function wakeFailed(round, error) {
    round.wakeSession?.close();
    round.wakeSession = undefined;
    if (round.policy.model) {
      setAudioProcessing(round, true);
      started(round);
      onWakeFallback?.();
    } else {
      stop(round);
      round.handlers.onError?.(error);
    }
  }

  function startWake(round) {
    const { policy } = round;
    const active = () => !round.closed && round.policy === policy;
    phase('正在准备本机唤醒');
    try {
      if (round.context.sampleRate !== 16000) throw new Error('MOBILE_STREAM_SAMPLE_RATE_UNAVAILABLE');
      round.wakeSession = openWake(policy.kws, policy.aliases.length, {
        ready() { if (active()) started(round); },
        hit({ aliasIndex, utteranceStartSample, replayFromSample }) {
          if (!active() || !Number.isSafeInteger(aliasIndex) || !policy.aliases[aliasIndex]
            || !Number.isSafeInteger(utteranceStartSample) || utteranceStartSample < 0
            || !Number.isSafeInteger(replayFromSample) || replayFromSample < utteranceStartSample
            || replayFromSample >= round.position) return;
          const now = Date.now();
          const recent = round.recentSpeech.filter(item => item.cutAt <= utteranceStartSample && now - item.capturedAt <= 90_000);
          const target = onWake?.(policy.aliases[aliasIndex], recent);
          if (target) changePolicy(round, target, replayFromSample);
        },
        error(error) { if (active()) wakeFailed(round, error); },
      });
    } catch (error) {
      wakeFailed(round, error);
    }
  }

  function changePolicy(round, policy, replayAfter) {
    const keepKeywordAudio = round.policy.kind === 'wake' && Boolean(round.wakeSession) && replayAfter !== undefined;
    const buffered = [];
    if (replayAfter !== undefined) {
      for (const { frame, after } of round.replay) {
        if (after <= replayAfter) continue;
        const start = after - frame.length;
        buffered.push({ after, frame:frame.subarray(Math.max(0, replayAfter - start)) });
      }
    }
    round.replay.length = 0;
    round.streamSession?.close();
    round.streamSession = undefined;
    round.wakeSession?.close();
    round.wakeSession = undefined;
    round.policy = policy;
    round.restoreAfterFinal = keepKeywordAudio;
    round.recentSpeech = [];
    round.backup = policy.kind === 'streaming' && (policy.fallbackModel || policy.fallbackWhileChecking)
      ? { segments:[], lastTimedEnd:0 } : undefined;
    round.frames = [];
    round.preRoll = [];
    round.samples = 0;
    round.speaking = false;
    round.lastAudible = 0;
    round.confirmedThrough = 0;
    if (!round.context) return;
    if (!keepKeywordAudio) setAudioProcessing(round, useConversationalAudio(policy));
    if (policy.kind === 'streaming') startStream(round, buffered);
    else if (policy.kind === 'wake' && policy.kws) startWake(round);
    else {
      started(round);
      for (const { frame, after } of buffered) captureLocal(round, frame, after);
    }
  }

  function handleLocalResult(round, policy, result, cutAt, capturedAt) {
    if (round.closed || round.policy !== policy) return;
    if (policy.kind !== 'wake') {
      finishInput(round, result);
      return;
    }
    const now = Date.now();
    round.recentSpeech = round.recentSpeech.filter(item => now - item.capturedAt <= 90_000);
    const hit = round.wakeSession ? null : matchWake?.(result.text, policy.aliases);
    if (!hit) {
      const text = [...String(result.text ?? '').trim()].slice(0, 256).join('');
      if (text && now - capturedAt <= 90_000) {
        round.recentSpeech.push({ text, capturedAt, cutAt });
        if (round.recentSpeech.length > 6) round.recentSpeech.shift();
      }
      return;
    }
    const target = onWake?.(hit.alias, round.recentSpeech);
    if (!target) return;
    if (hit.text) round.handlers.onFinal?.({ ...result, text: hit.text });
    changePolicy(round, target, cutAt);
  }

  function submit(round, end) {
    if (!round.samples || round.closed) return;
    const { frames, samples, lastAudible } = round;
    const segment = { frames, samples, end, lastAudible, capturedAt:Date.now() };
    round.frames = [];
    round.samples = 0;
    if (round.backup) {
      if (lastAudible <= round.confirmedThrough) return;
      const segments = round.backup.segments;
      // Keep only recent unconfirmed microphone audio, and use local ASR only if the stream fails.
      segments.push(segment);
      if (segments.length > 4) segments.shift();
      return;
    }
    transcribeSegment(round, segment);
  }

  function transcribeSegment(round, { frames, samples, end, lastAudible, capturedAt }) {
    if (round.closed || lastAudible <= round.confirmedThrough) return;
    const policy = round.policy;
    const canRecognize = () => !round.closed && round.policy === policy;
    if (round.pending >= 4) {
      stop(round);
      round.handlers.onError?.(new Error('MOBILE_ASR_BACKLOG'));
      return;
    }
    round.pending++;
    if (policy.kind === 'utterance') phase('正在转写');
    round.queue = round.queue.then(async () => {
      try {
        if (!canRecognize()) return;
        const skip = Math.max(0, round.confirmedThrough - (end - samples));
        const result = await transcribe(encodeWave(frames, samples, round.context.sampleRate, skip), round.control.signal, policy);
        handleLocalResult(round, policy, result, end, capturedAt);
      } catch (error) {
        if (canRecognize()) {
          stop(round);
          round.handlers.onError?.(error);
        }
      } finally {
        if (!--round.pending && !round.closed && round.policy === policy && policy.kind !== 'streaming' && !round.speaking) started(round);
      }
    });
  }

  function limitPreRoll(round, frameLength) {
    const frames = round.preRoll;
    const sampleRate = round.context.sampleRate;
    if (!round.restoreAfterFinal) {
      while (frames.length > Math.ceil(0.2 * sampleRate / frameLength)) frames.shift();
      return;
    }
    // The first command may start below the gate just after the native keyword boundary.
    // The first replay frame can be partial, so bound the accumulated PCM by sample count.
    let drop = frames.reduce((samples, frame) => samples + frame.length, 0) - keywordReplaySeconds * sampleRate;
    while (drop > 0) {
      const first = frames[0];
      if (drop < first.length) {
        frames[0] = first.subarray(drop);
        return;
      }
      drop -= frames.shift().length;
    }
  }

  function captureLocal(round, frame, after = round.position) {
    const sampleRate = round.context.sampleRate;
    const rms = Math.sqrt(frame.reduce((power, sample) => power + sample ** 2, 0) / frame.length);
    waveform(rms);
    const audible = rms >= 0.025;
    if (!round.speaking && !audible) {
      round.preRoll.push(frame);
      limitPreRoll(round, frame.length);
      return;
    }
    if (!round.speaking) {
      round.speaking = true;
      round.silence = 0;
      round.frames = round.preRoll.splice(0);
      round.samples = round.frames.reduce((sum, item) => sum + item.length, 0);
      if (round.policy.kind === 'utterance') {
        phase('正在收音');
        round.handlers.onSpeechStart?.();
      }
      if (round.closed) return;
    }
    round.frames.push(frame);
    round.samples += frame.length;
    if (audible) round.lastAudible = after;
    round.silence = audible ? 0 : round.silence + frame.length / sampleRate;
    if (round.silence < 0.6 && round.samples < sampleRate * 18) return;
    round.speaking = false;
    if (round.policy.kind === 'utterance') round.handlers.onSpeechEnd?.();
    submit(round, after);
  }

  return {
    adapterId: 'rabi-mobile-pcm',
    setPolicy(policy) {
      if (current) changePolicy(current, policy);
    },
    beforePlayback() {
      const pending = current?.processingJob;
      if (!pending) return;
      return new Promise(resolve => {
        const timeout = setTimeout(resolve, 250);
        void pending.then(() => { clearTimeout(timeout); resolve(); });
      });
    },
    createRound(handlers) {
      return {
        handlers, policy: getPolicy(), closed: false, started: false, frames: [], preRoll: [], replay: [], position: 0,
        samples: 0, silence: 0, speaking: false, pending: 0, lastAudible: 0, confirmedThrough: 0,
        recentSpeech: [], queue: Promise.resolve(), control: new AbortController(),
      };
    },
    async start(round) {
      try {
        if (!mayRecord()) throw new Error('MOBILE_MICROPHONE_IN_USE');
        current = round;
        round.audioProcessing = useConversationalAudio(round.policy);
        round.stream = await navigator.mediaDevices.getUserMedia({
          audio: round.audioProcessing ? conversationalAudio : keywordAudio, video: false,
        });
        if (round.closed) {
          round.stream.getTracks().forEach(track => track.stop());
          return;
        }
        round.context = new AudioContext({ sampleRate: 16000 });
        await round.context.resume();
        if (round.closed) return;
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
          round.position += frame.length;
          if (round.policy.kind === 'streaming') {
            if (round.backup) captureLocal(round, frame);
            if (!round.streamSession?.write(frame)) streamFailed(round, new Error('MOBILE_STREAM_BACKLOG'));
            return;
          }
          if (round.policy.kind === 'wake') {
            round.replay.push({ frame, after: round.position });
            // A text-only wake check can outlast the fast on-device keyword window.
            const replaySeconds = !round.wakeSession && round.pending > 0 ? pendingWakeReplaySeconds : keywordReplaySeconds;
            const firstSample = round.position - replaySeconds * round.context.sampleRate;
            while (round.replay[0].after <= firstSample) round.replay.shift();
            if (round.wakeSession && !round.wakeSession.write(frame, round.position)) {
              wakeFailed(round, new Error('MOBILE_WAKE_BACKLOG'));
            }
            if (!round.policy.model || round.closed) return;
          }
          captureLocal(round, frame);
        };
        for (const track of round.stream.getTracks()) track.addEventListener('ended', () => {
          if (round.closed) return;
          stop(round);
          round.handlers.onEnd?.();
        }, { once: true });
        changePolicy(round, round.policy);
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


export function encodeWave(frames, sampleCount, sampleRate, skip = 0) {
  const samples = new Float32Array(sampleCount);
  let offset = 0;
  for (const frame of frames) {
    samples.set(frame, offset);
    offset += frame.length;
  }
  const targetRate = 16000;
  const step = sampleRate / targetRate;
  const length = Math.floor((sampleCount - skip) / step);
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
    const start = skip + Math.floor(index * step);
    const end = Math.min(sampleCount, Math.max(start + 1, skip + Math.floor((index + 1) * step)));
    let sum = 0;
    for (let sample = start; sample < end; sample++) sum += samples[sample];
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return new Uint8Array(view.buffer);
}
