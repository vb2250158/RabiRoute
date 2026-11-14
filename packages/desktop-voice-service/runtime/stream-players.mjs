/** Incremental PCM playback. Stop fences queued and late audio before closing resources. */
export function createStreamPlayers({ AudioContext, send, maxQueuedSeconds = 60 }) {
  const players = new Map();
  const current = id => { const item = players.get(id); if (!item || item.stopped) throw Error('DEVICE_STREAM_MISSING'); return item; };
  const ended = item => {
    if (item.finished && !item.stopped && !item.queue.length && !item.sources.size && !item.ended) {
      item.ended = true; send({ event: 'player.ended', id: item.id });
    }
  };
  const pump = item => {
    if (!item.playing || item.stopped) return;
    for (const samples of item.queue.splice(0)) {
      const buffer = item.context.createBuffer(1, samples.length, item.rate);
      buffer.getChannelData(0).set(samples);
      const source = item.context.createBufferSource(); source.buffer = buffer; source.connect(item.context.destination);
      item.sources.add(source);
      source.onended = () => {
        source.disconnect();
        if (!item.sources.delete(source)) return;
        item.queuedSamples -= samples.length; ended(item);
      };
      const start = Math.max(item.context.currentTime + .02, item.tail);
      item.tail = start + samples.length / item.rate;
      source.start(start);
    }
    ended(item);
  };
  const stop = item => {
    if (item.stopped) return;
    item.stopped = true; item.queue = [];
    for (const source of item.sources) { source.onended = null; source.stop(); source.disconnect(); }
    item.sources.clear(); item.queuedSamples = 0;
  };
  return {
    has: id => players.has(id),
    async create({ id, sampleRate, outputDeviceId }) {
      if (players.has(id) || players.size >= 4 || ![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate)) throw Error('DEVICE_STREAM_CONFIG_INVALID');
      const context = new AudioContext({ sampleRate });
      const item = { id, rate: sampleRate, context, queue: [], sources: new Set(), queuedSamples: 0, tail: 0, playing: false, stopped: false, finished: false, ended: false };
      players.set(id, item);
      try {
        if (outputDeviceId) {
          if (typeof context.setSinkId !== 'function') throw Error('DEVICE_OUTPUT_SELECTION_UNSUPPORTED');
          await context.setSinkId(outputDeviceId);
        }
        await context.suspend();
        if (item.stopped) throw Error('DEVICE_STREAM_MISSING');
      } catch (error) { await context.close(); players.delete(id); throw error; }
    },
    append(id, bytes) {
      const item = current(id);
      if (item.finished || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length % 2 || bytes.length > 256000) throw Error('DEVICE_PCM_INVALID');
      const length = bytes.length / 2;
      if (item.queuedSamples + length > item.rate * maxQueuedSeconds) throw Error('DEVICE_PLAYBACK_BACKLOG');
      const samples = new Float32Array(length), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      item.queuedSamples += length; item.queue.push(samples); pump(item);
    },
    async play(id) { const item = current(id); await item.context.resume(); if (item.stopped) return; item.playing = true; pump(item); },
    finish(id) { const item = current(id); item.finished = true; ended(item); },
    stop(id) { const item = players.get(id); if (item) stop(item); },
    async dispose(id) { const item = players.get(id); if (!item) return; stop(item); await item.context.close(); players.delete(id); },
  };
}
