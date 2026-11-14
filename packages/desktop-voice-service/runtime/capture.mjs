/** Owns acquisition through confirmed release, including uncancellable permission waits. */
export function createCaptureRegistry({ mediaDevices, AudioContext, AudioWorkletNode, send }) {
  const recordings = new Map();
  async function release(id) {
    const item = recordings.get(id);
    if (!item) return;
    if (item.releasing) return item.releasing;
    item.closed = true;
    item.releasing = (async () => {
      // getUserMedia cannot be cancelled. Keep ownership until its late result is
      // returned. The Host's request deadline tears down the owned Job if it hangs.
      await item.acquisition.catch(() => {});
      item.stream?.getTracks().forEach(track => track.stop());
      item.node?.disconnect(); item.source?.disconnect(); item.gain?.disconnect();
      if (item.context && item.context.state !== 'closed') await item.context.close();
      recordings.delete(id);
    })();
    return item.releasing;
  }
  function current(id) {
    const item = recordings.get(id);
    if (!item || item.closed || !item.ready) throw Error('DEVICE_CAPTURE_MISSING');
    return item;
  }
  return {
    async start(p) {
      if (recordings.size) throw Error('DEVICE_CAPTURE_BUSY');
      const duration = Number.isFinite(p.maxDurationMs) ? p.maxDurationMs : 30000;
      const item = { closed: false, ready: false, chunks: [], samples: 0, spoken: false,
        limit: 16000 * Math.min(180, Math.max(1, duration / 1000)) };
      recordings.set(p.id, item);
      const check = () => { if (item.closed) throw Error('DEVICE_CAPTURE_CANCELLED'); };
      const interrupted = () => {
        if (item.closed) return;
        send({ event: 'record.error', id: p.id });
        void release(p.id).catch(() => send({ event: 'record.error', id: p.id }));
      };
      item.acquisition = Promise.resolve().then(async () => {
        check();
        item.stream = await mediaDevices.getUserMedia({ audio: {
          echoCancellation: true, noiseSuppression: true, channelCount: 1,
          ...(p.inputDeviceId ? { deviceId: { exact: p.inputDeviceId } } : {}),
        }, video: false });
        check();
        item.context = new AudioContext({ sampleRate: 16000 });
        if (item.context.sampleRate !== 16000) throw Error('DEVICE_SAMPLE_RATE_UNAVAILABLE');
        await item.context.audioWorklet.addModule('./capture-worklet.js'); check();
        item.source = item.context.createMediaStreamSource(item.stream);
        item.node = new AudioWorkletNode(item.context, 'voice-capture');
        item.gain = item.context.createGain(); item.gain.gain.value = 0;
        item.source.connect(item.node); item.node.connect(item.gain); item.gain.connect(item.context.destination);
        item.node.port.onmessage = event => {
          if (item.closed || !(event.data instanceof Float32Array)) return;
          const chunk = event.data;
          if (p.streaming) {
            const bytes = new Uint8Array(chunk.length * 2), view = new DataView(bytes.buffer);
            for (let i = 0; i < chunk.length; i++) view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(chunk[i] * 32768))), true);
            let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
            send({ event: 'record.pcm', id: p.id, audio: btoa(binary) });
          } else { item.chunks.push(chunk); item.samples += chunk.length; }
          let sum = 0; for (const value of chunk) sum += value * value;
          send({ event: 'record.level', id: p.id, value: Math.sqrt(sum / chunk.length) });
          if (!item.spoken) while (item.samples > 8000 && item.chunks.length > 1) item.samples -= item.chunks.shift().length;
          if (item.samples > item.limit + 16000) interrupted();
        };
        item.stream.getTracks().forEach(track => track.addEventListener('ended', interrupted));
        await item.context.resume(); check(); item.ready = true;
      });
      try { await item.acquisition; return true; }
      catch (error) { await release(p.id); throw error; }
    },
    mark(id) { current(id).spoken = true; },
    take(id) {
      const item = current(id), samples = new Float32Array(item.samples);
      let offset = 0; for (const chunk of item.chunks) { samples.set(chunk, offset); offset += chunk.length; }
      item.chunks = []; item.samples = 0; item.spoken = false;
      return samples;
    },
    release,
  };
}
