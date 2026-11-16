/** Incremental PCM playback. Stop fences queued and late audio before closing resources. */
export function createStreamPlayers({ AudioContext, send, maxQueuedSeconds = 60, clock=globalThis }) {
  const players = new Map();
  const progress=item=>{
    if(item.stopped)return;
    let samples=item.completedSamples,started=samples>0;
    for(const segment of item.segments.values())if(item.context.currentTime>=segment.start){started=true;samples=Math.max(samples,segment.offset+Math.min(segment.length,Math.max(0,item.context.currentTime-segment.start)*item.rate))}
    if(started&&samples>item.lastProgress){item.lastProgress=samples;send({event:'player.progress',id:item.id,seconds:samples/item.rate})}
  };
  const clearProgress=item=>{if(item.progressTimer!==null)clock.clearInterval(item.progressTimer);item.progressTimer=null};
  const current = id => { const item = players.get(id); if (!item || item.stopped) throw Error('DEVICE_STREAM_MISSING'); return item; };
  const ended = item => {
    if (item.finished && !item.stopped && !item.queue.length && !item.sources.size && !item.ended) {
      progress(item);clearProgress(item);item.ended = true; send({ event: 'player.ended', id: item.id });
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
        const segment=item.segments.get(source);item.completedSamples=Math.max(item.completedSamples,segment.offset+segment.length);item.segments.delete(source);progress(item);
        item.queuedSamples -= samples.length;
        for(const ready of item.capacityWaiters)ready();item.capacityWaiters.clear();
        ended(item);
      };
      const start = Math.max(item.context.currentTime + .02, item.tail);
      item.segments.set(source,{start,offset:item.scheduledSamples,length:samples.length});item.scheduledSamples+=samples.length;
      item.tail = start + samples.length / item.rate;
      source.start(start);
      if(item.progressTimer===null)item.progressTimer=clock.setInterval(()=>progress(item),40);
    }
    ended(item);
  };
  const stop = item => {
    if (item.stopped) return;
    item.stopped = true;clearProgress(item);item.segments.clear();item.queue = [];
    for (const source of item.sources) { source.onended = null; source.stop(); source.disconnect(); }
    item.sources.clear(); item.queuedSamples = 0;
    for(const ready of item.capacityWaiters)ready();item.capacityWaiters.clear();
  };
  return {
    has: id => players.has(id),
    async create({ id, sampleRate, outputDeviceId }) {
      if (players.has(id) || players.size >= 4 || ![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate)) throw Error('DEVICE_STREAM_CONFIG_INVALID');
      const context = new AudioContext({ sampleRate });
      const item = { id, rate: sampleRate, context, queue: [], sources: new Set(),segments:new Map(),scheduledSamples:0,completedSamples:0,lastProgress:-1,progressTimer:null, capacityWaiters:new Set(), queuedSamples: 0, tail: 0, playing: false, stopped: false, finished: false, ended: false };
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
    async append(id, bytes) {
      const item = current(id);
      if (item.finished || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length % 2 || bytes.length > 256000) throw Error('DEVICE_PCM_INVALID');
      const length = bytes.length / 2;
      if(length>item.rate*maxQueuedSeconds)throw Error('DEVICE_PCM_INVALID');
      // Apply backpressure at the player boundary instead of failing valid long
      // replies. Stop wakes these waiters before releasing native resources.
      while(item.queuedSamples+length>item.rate*maxQueuedSeconds){
        await new Promise(resolve=>item.capacityWaiters.add(resolve));
        current(id);
      }
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
