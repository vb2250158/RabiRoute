// Browser host boundary only. Conversation, interruption and HUD logic stay in the AIUI bundle.
function wavFromPcm(chunks, sampleRate) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const wav = new Uint8Array(44 + size);
  const data = new DataView(wav.buffer);
  const ascii = (offset, text) => [...text].forEach((char, index) => data.setUint8(offset + index, char.charCodeAt(0)));
  ascii(0, 'RIFF'); data.setUint32(4, size + 36, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
  data.setUint32(24, sampleRate, true); data.setUint32(28, sampleRate * 2, true);
  data.setUint16(32, 2, true); data.setUint16(34, 16, true); ascii(36, 'data'); data.setUint32(40, size, true);
  let offset = 44;
  for (const chunk of chunks) { wav.set(chunk, offset); offset += chunk.length; }
  return wav;
}

export function createSimulatorHost({ mode, config, token, emit, report, request = fetch }) {
  // Includes the in-flight segment. Keep slow API service from retaining an
  // unbounded recording while audio capture continues to accept new chunks.
  const maxPendingRecognitionSegments = 4;
  const recognitionSessions = new Map();
  const synthesisTasks = new Map();
  let disposed = false;
  let queuedText = '';
  let inputContext;
  let inputDestination;
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
  const post = async (route, body, signal, contentType = 'application/json') => {
    const response = await request(route, { method: 'POST', headers: { 'content-type': contentType, 'x-simulator-token': token }, body, signal });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `HTTP ${response.status}`);
    }
    return response;
  };
  const event = (type, detail) => { if (!disposed) emit(type, detail); };
  const publishText = (session, text) => {
    if (session.closed || disposed || recognitionSessions.get(session.request.sessionId) !== session) return;
    // Text injection completes the simulated utterance. Real microphone VAD
    // owns its speechend independently of segmented transcription results.
    if (mode === 'text' && session.speechStarted) {
      session.speechStarted = false;
      event('speech.speechend', session.request);
    }
    event('speech.result', { ...session.request, resultIndex: session.resultIndex++, isFinal: true, alternatives: [{ transcript: text, confidence: 1 }] });
    report('asr', mode === 'text' ? '模拟识别结果' : 'API 识别结果', text);
  };
  const closeRecognition = (session, graceful) => {
    if (session.closed) return;
    session.closed = true;
    session.chunks = [];
    clearTimeout(session.timer);
    session.controller.abort();
    session.resolveClosed();
    if (recognitionSessions.get(session.request.sessionId) === session) recognitionSessions.delete(session.request.sessionId);
    event('speech.end', session.request);
    report('asr', graceful ? '识别已结束' : '识别已停止');
  };
  const failRecognition = (session, message) => {
    if (session.closed || disposed) return;
    event('speech.error', { ...session.request, error: 'network', message });
    report('asr', '识别失败', message);
    closeRecognition(session, false);
  };
  const flush = (session) => {
    if (session.closed || !session.hasVoice || !session.chunks.length) return;
    if (session.pendingSegments >= maxPendingRecognitionSegments) {
      failRecognition(session, '识别服务跟不上输入，录音已停止，请稍后重新开始');
      throw new Error('ASR_BUFFER_FULL');
    }
    const chunks = session.chunks.splice(0);
    session.samples = 0;
    session.hasVoice = false;
    session.pendingSegments++;
    session.transcription = session.transcription.then(async () => {
      if (session.closed || disposed) return;
      report('asr', '正在识别录音');
      const response = post('/api/transcribe', wavFromPcm(chunks, session.sampleRate), session.controller.signal, 'audio/wav')
        .then(value => value.json());
      // Aborting the host must not wait for an uncooperative upstream promise.
      const result = await Promise.race([response, session.whenClosed]);
      if (session.closed || disposed) return;
      if (typeof result?.text !== 'string') throw new Error('ASR_RESPONSE_INVALID');
      if (result.text.trim()) publishText(session, result.text.trim());
    }).catch(() => failRecognition(session, 'ASR 请求失败，请重新开始识别'))
      .finally(() => { session.pendingSegments--; });
  };
  const endRecognition = async (request, graceful) => {
    const session = recognitionSessions.get(request.sessionId);
    if (!session) return;
    if (!graceful) { closeRecognition(session, false); return; }
    if (session.finishing) return session.finishing;
    session.acceptingAudio = false;
    clearTimeout(session.timer);
    session.finishing = (async () => {
      try {
        flush(session);
        await Promise.race([session.transcription, session.whenClosed]);
      } finally { closeRecognition(session, true); }
    })();
    return session.finishing;
  };
  const speech = {
    getRecognitionCapabilities() {
      report('host', 'speech.getRecognitionCapabilities');
      if (mode === 'microphone' && (!config.baseUrl || !config.asrModel)) throw new Error('真实麦克风模式需要配置 ASR API');
      return { audioFormats: [{ mimeType: 'audio/pcm', sampleRates: [16000], channelCounts: [1], sampleFormats: ['s16'] }], maxChunkBytes: 16384, interimResults: false, maxAlternatives: 1, phrases: false, contextUpdates: false, segmentationModes: ['auto'] };
    },
    openRecognitionStream(request) {
      if (disposed) throw new Error('测试宿主已关闭');
      if (recognitionSessions.has(request.sessionId)) throw new Error('识别会话已经存在');
      const session = { request, resultIndex: 0, chunks: [], samples: 0, hasVoice: false, speechStarted: false, voicedSamples: 0, silenceSamples: 0, sampleRate: request.audio.sampleRate || 16000, controller: new AbortController(), closed: false,
        acceptingAudio: true, pendingSegments: 0, transcription: Promise.resolve(), finishing: null };
      session.whenClosed = new Promise(resolve => { session.resolveClosed = resolve; });
      recognitionSessions.set(request.sessionId, session);
      report('asr', mode === 'text' ? '模拟输入已就绪（未打开麦克风）' : '麦克风音频流已打开');
      session.timer = setTimeout(() => {
        if (session.closed) return;
        event('speech.start', request);
        if (queuedText) { const text = queuedText; queuedText = ''; publishText(session, text); }
      }, 100);
    },
    async writeRecognitionAudio(request) {
      const session = recognitionSessions.get(request.sessionId);
      if (!session || session.closed || !session.acceptingAudio) return;
      const bytes = request.bytes;
      if (bytes.length % 2) throw new Error('PCM 音频没有按 s16 对齐');
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let squareSum = 0;
      for (let i = 0; i < bytes.length; i += 2) squareSum += (data.getInt16(i, true) / 32768) ** 2;
      const samples = bytes.length / 2;
      const rms = Math.sqrt(squareSum / Math.max(1, samples));
      const voiced = rms > 0.012;
      if (voiced) { session.hasVoice = true; session.silenceSamples = 0; }
      else session.silenceSamples += samples;
      // Local microphone VAD supplies onset before the slower transcription API.
      // Keep its state across the 12-second ASR buffer split: splitting audio is
      // not a new utterance. This energy heuristic does not establish AEC support.
      session.voicedSamples = voiced ? session.voicedSamples + samples : 0;
      if (mode === 'microphone' && !session.speechStarted && session.voicedSamples >= session.sampleRate * 0.04) {
        session.speechStarted = true;
        event('speech.speechstart', session.request);
        report('asr', '麦克风检测到开口（本地音量判断）');
      }
      if (mode === 'microphone' && session.speechStarted && session.silenceSamples >= session.sampleRate * 0.8) {
        session.speechStarted = false;
        event('speech.speechend', session.request);
      }
      session.chunks.push(bytes.slice());
      session.samples += samples;
      // Bounded buffering; silence before speech retains only a short lead-in.
      if (!session.hasVoice && session.samples > session.sampleRate / 2) { session.chunks = [bytes.slice()]; session.samples = samples; }
      if (session.hasVoice && (session.silenceSamples >= session.sampleRate * 0.8 || session.samples >= session.sampleRate * 12)) flush(session);
    },
    finishRecognitionStream: request => endRecognition(request, true),
    abortRecognitionStream: request => endRecognition(request, false),
    stopRecognition: request => endRecognition(request, true),
    abortRecognition: request => endRecognition(request, false),
    synthesize(request) {
      if (!config.ttsModel || !config.voice) throw new Error('尚未配置 TTS 模型和音色');
      const task = { controller: new AbortController(), timer: null };
      synthesisTasks.set(request.synthesisId, task);
      report('tts', '合成请求', request.text);
      // Deliver metadata before chunks so Ink can attach its independent player.
      task.timer = setTimeout(async () => {
        let received = 0;
        let sequence = 0;
        let carry = new Uint8Array();
        try {
          const response = await post('/api/speech', JSON.stringify({ text: request.text }), task.controller.signal);
          for await (const chunk of response.body) {
            if (task.controller.signal.aborted) return;
            const joined = new Uint8Array(carry.length + chunk.length);
            joined.set(carry); joined.set(chunk, carry.length);
            const length = joined.length - joined.length % 2;
            carry = joined.slice(length);
            for (let offset = 0; offset < length; offset += 8192) {
              const audio = joined.slice(offset, Math.min(length, offset + 8192));
              received += audio.length;
              event('speech.synthesisChunk', { synthesisId: request.synthesisId, sequence: sequence++, audio, cues: [] });
            }
          }
          if (!received || carry.length) throw new Error('TTS 未返回有效的 24 kHz / s16 / 单声道 PCM');
          event('speech.synthesisEnd', { synthesisId: request.synthesisId, durationMs: received / 48 });
          report('tts', '音频已交给 Ink 播放器', `${received} bytes；合成结束不等于听到声音`);
        } catch (error) {
          if (!task.controller.signal.aborted) {
            event('speech.synthesisError', { synthesisId: request.synthesisId, error: 'network', message: error.message });
            report('tts', '合成失败', error.message);
          }
        } finally { synthesisTasks.delete(request.synthesisId); }
      }, 50);
      return { synthesisId: request.synthesisId, mimeType: 'audio/pcm', audioConfig: { format: 'pcm', sampleRate: 24000, channels: 1, sampleFormat: 's16' }, language: request.lang || 'zh-CN', subtitleGranularity: 'none' };
    },
    abortSynthesis(request) {
      const task = synthesisTasks.get(request.synthesisId);
      if (!task) return;
      clearTimeout(task.timer);
      task.controller.abort();
      synthesisTasks.delete(request.synthesisId);
      event('speech.synthesisAborted', request);
      report('tts', '合成已取消');
    }
  };
  const capabilities = {
    speech,
    languageModel: {
      getConfig() {
        if (!config.configured) throw new Error('尚未配置模型 API');
        report('model', '模型配置已提供', config.model);
        return { endpoint: `${location.origin}/api/chat`, defaultModel: config.model, apiStyle: 'openai-chat-completions', headers: { 'x-simulator-token': token }, shareVendorHeaders: false };
      }
    }
  };
  if (mode === 'text') {
    // Ink's Web capture provider opens a browser MediaStream directly before the
    // host recorder hook. Supply a real, silent virtual stream only in this local
    // simulator document. No hardware permission or microphone capture is used.
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (disposed || constraints.video) throw new Error('模拟文字输入只支持音频');
      inputContext ||= new AudioContext({ sampleRate: 16000 });
      inputDestination ||= inputContext.createMediaStreamDestination();
      await inputContext.resume();
      report('host', '浏览器虚拟静音流（未打开麦克风）');
      return inputDestination.stream.clone();
    };
  }
  return {
    capabilities,
    injectSpeechStart() {
      if (mode !== 'text') throw new Error('模拟开口仅用于文字输入模式');
      const session = [...recognitionSessions.values()].find(value => !value.closed);
      if (!session || disposed) return false;
      session.speechStarted = true;
      event('speech.speechstart', session.request);
      report('asr', '模拟开口（尚无识别文字）');
      return true;
    },
    injectText(text) {
      if (mode !== 'text') throw new Error('请先选择模拟文字输入');
      const session = [...recognitionSessions.values()].find(value => !value.closed);
      if (session) publishText(session, text);
      else queuedText = text;
      return Boolean(session);
    },
    async dispose() {
      disposed = true;
      if (mode === 'text') navigator.mediaDevices.getUserMedia = originalGetUserMedia;
      inputDestination?.stream.getTracks().forEach(track => track.stop());
      await inputContext?.close();
      queuedText = '';
      await Promise.all([...recognitionSessions.values()].map(session => endRecognition(session.request, false)));
      for (const [synthesisId] of synthesisTasks) speech.abortSynthesis({ synthesisId });
    }
  };
}
