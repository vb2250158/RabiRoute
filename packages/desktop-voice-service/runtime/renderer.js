"use strict";
(() => {
  // runtime/recording.ts
  function encodeWave(samples) {
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    const text = (at, value) => {
      for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
    };
    text(0, "RIFF");
    view.setUint32(4, bytes.length - 8, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16e3, true);
    view.setUint32(28, 32e3, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, samples.length * 2, true);
    for (const [i, sample] of samples.entries()) {
      const value = Math.max(-1, Math.min(1, sample));
      view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    return bytes;
  }
  function audioBase64(bytes) {
    let text = "";
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(text);
  }

  // runtime/capture.mjs
  function createCaptureRegistry({ mediaDevices, AudioContext: AudioContext2, AudioWorkletNode: AudioWorkletNode2, send: send2 }) {
    const recordings = /* @__PURE__ */ new Map();
    async function release(id) {
      const item = recordings.get(id);
      if (!item) return;
      if (item.releasing) return item.releasing;
      item.closed = true;
      item.releasing = (async () => {
        await item.acquisition.catch(() => {
        });
        item.stream?.getTracks().forEach((track) => track.stop());
        item.node?.disconnect();
        item.source?.disconnect();
        item.gain?.disconnect();
        if (item.context && item.context.state !== "closed") await item.context.close();
        recordings.delete(id);
      })();
      return item.releasing;
    }
    function current(id) {
      const item = recordings.get(id);
      if (!item || item.closed || !item.ready) throw Error("DEVICE_CAPTURE_MISSING");
      return item;
    }
    return {
      async start(p) {
        if (recordings.size) throw Error("DEVICE_CAPTURE_BUSY");
        const duration = Number.isFinite(p.maxDurationMs) ? p.maxDurationMs : 3e4;
        const item = {
          closed: false,
          ready: false,
          chunks: [],
          samples: 0,
          spoken: false,
          limit: 16e3 * Math.min(180, Math.max(1, duration / 1e3))
        };
        recordings.set(p.id, item);
        const check = () => {
          if (item.closed) throw Error("DEVICE_CAPTURE_CANCELLED");
        };
        const interrupted = () => {
          if (item.closed) return;
          send2({ event: "record.error", id: p.id });
          void release(p.id).catch(() => send2({ event: "record.error", id: p.id }));
        };
        item.acquisition = Promise.resolve().then(async () => {
          check();
          item.stream = await mediaDevices.getUserMedia({ audio: {
            echoCancellation: true,
            noiseSuppression: true,
            channelCount: 1,
            ...p.inputDeviceId ? { deviceId: { exact: p.inputDeviceId } } : {}
          }, video: false });
          check();
          item.context = new AudioContext2({ sampleRate: 16e3 });
          if (item.context.sampleRate !== 16e3) throw Error("DEVICE_SAMPLE_RATE_UNAVAILABLE");
          await item.context.audioWorklet.addModule("./capture-worklet.js");
          check();
          item.source = item.context.createMediaStreamSource(item.stream);
          item.node = new AudioWorkletNode2(item.context, "voice-capture");
          item.gain = item.context.createGain();
          item.gain.gain.value = 0;
          item.source.connect(item.node);
          item.node.connect(item.gain);
          item.gain.connect(item.context.destination);
          item.node.port.onmessage = (event) => {
            if (item.closed || !(event.data instanceof Float32Array)) return;
            const chunk = event.data;
            if (p.streaming) {
              const bytes = new Uint8Array(chunk.length * 2), view = new DataView(bytes.buffer);
              for (let i = 0; i < chunk.length; i++) view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(chunk[i] * 32768))), true);
              let binary = "";
              for (const byte of bytes) binary += String.fromCharCode(byte);
              send2({ event: "record.pcm", id: p.id, audio: btoa(binary) });
            } else {
              item.chunks.push(chunk);
              item.samples += chunk.length;
            }
            let sum = 0;
            for (const value of chunk) sum += value * value;
            send2({ event: "record.level", id: p.id, value: Math.sqrt(sum / chunk.length) });
            if (!item.spoken) while (item.samples > 8e3 && item.chunks.length > 1) item.samples -= item.chunks.shift().length;
            if (item.samples > item.limit + 16e3) interrupted();
          };
          item.stream.getTracks().forEach((track) => track.addEventListener("ended", interrupted));
          await item.context.resume();
          check();
          item.ready = true;
        });
        try {
          await item.acquisition;
          return true;
        } catch (error) {
          await release(p.id);
          throw error;
        }
      },
      mark(id) {
        current(id).spoken = true;
      },
      take(id) {
        const item = current(id), samples = new Float32Array(item.samples);
        let offset = 0;
        for (const chunk of item.chunks) {
          samples.set(chunk, offset);
          offset += chunk.length;
        }
        item.chunks = [];
        item.samples = 0;
        item.spoken = false;
        return samples;
      },
      release
    };
  }

  // runtime/stream-players.mjs
  function createStreamPlayers({ AudioContext: AudioContext2, send: send2, maxQueuedSeconds = 60, clock = globalThis }) {
    const players2 = /* @__PURE__ */ new Map();
    const progress = (item) => {
      if (item.stopped) return;
      let samples = item.completedSamples, started = samples > 0;
      for (const segment of item.segments.values()) if (item.context.currentTime >= segment.start) {
        started = true;
        samples = Math.max(samples, segment.offset + Math.min(segment.length, Math.max(0, item.context.currentTime - segment.start) * item.rate));
      }
      if (started && samples > item.lastProgress) {
        item.lastProgress = samples;
        send2({ event: "player.progress", id: item.id, seconds: samples / item.rate });
      }
    };
    const clearProgress = (item) => {
      if (item.progressTimer !== null) clock.clearInterval(item.progressTimer);
      item.progressTimer = null;
    };
    const current = (id) => {
      const item = players2.get(id);
      if (!item || item.stopped) throw Error("DEVICE_STREAM_MISSING");
      return item;
    };
    const ended = (item) => {
      if (item.finished && !item.stopped && !item.queue.length && !item.sources.size && !item.ended) {
        progress(item);
        clearProgress(item);
        item.ended = true;
        send2({ event: "player.ended", id: item.id });
      }
    };
    const pump = (item) => {
      if (!item.playing || item.stopped) return;
      for (const samples of item.queue.splice(0)) {
        const buffer = item.context.createBuffer(1, samples.length, item.rate);
        buffer.getChannelData(0).set(samples);
        const source = item.context.createBufferSource();
        source.buffer = buffer;
        source.connect(item.context.destination);
        item.sources.add(source);
        source.onended = () => {
          source.disconnect();
          if (!item.sources.delete(source)) return;
          const segment = item.segments.get(source);
          item.completedSamples = Math.max(item.completedSamples, segment.offset + segment.length);
          item.segments.delete(source);
          progress(item);
          item.queuedSamples -= samples.length;
          for (const ready of item.capacityWaiters) ready();
          item.capacityWaiters.clear();
          ended(item);
        };
        const start = Math.max(item.context.currentTime + 0.02, item.tail);
        item.segments.set(source, { start, offset: item.scheduledSamples, length: samples.length });
        item.scheduledSamples += samples.length;
        item.tail = start + samples.length / item.rate;
        source.start(start);
        if (item.progressTimer === null) item.progressTimer = clock.setInterval(() => progress(item), 40);
      }
      ended(item);
    };
    const stop = (item) => {
      if (item.stopped) return;
      item.stopped = true;
      clearProgress(item);
      item.segments.clear();
      item.queue = [];
      for (const source of item.sources) {
        source.onended = null;
        source.stop();
        source.disconnect();
      }
      item.sources.clear();
      item.queuedSamples = 0;
      for (const ready of item.capacityWaiters) ready();
      item.capacityWaiters.clear();
    };
    return {
      has: (id) => players2.has(id),
      async create({ id, sampleRate, outputDeviceId }) {
        if (players2.has(id) || players2.size >= 4 || ![8e3, 16e3, 22050, 24e3, 32e3, 44100, 48e3].includes(sampleRate)) throw Error("DEVICE_STREAM_CONFIG_INVALID");
        const context = new AudioContext2({ sampleRate });
        const item = { id, rate: sampleRate, context, queue: [], sources: /* @__PURE__ */ new Set(), segments: /* @__PURE__ */ new Map(), scheduledSamples: 0, completedSamples: 0, lastProgress: -1, progressTimer: null, capacityWaiters: /* @__PURE__ */ new Set(), queuedSamples: 0, tail: 0, playing: false, stopped: false, finished: false, ended: false };
        players2.set(id, item);
        try {
          if (outputDeviceId) {
            if (typeof context.setSinkId !== "function") throw Error("DEVICE_OUTPUT_SELECTION_UNSUPPORTED");
            await context.setSinkId(outputDeviceId);
          }
          await context.suspend();
          if (item.stopped) throw Error("DEVICE_STREAM_MISSING");
        } catch (error) {
          await context.close();
          players2.delete(id);
          throw error;
        }
      },
      async append(id, bytes) {
        const item = current(id);
        if (item.finished || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length % 2 || bytes.length > 256e3) throw Error("DEVICE_PCM_INVALID");
        const length = bytes.length / 2;
        if (length > item.rate * maxQueuedSeconds) throw Error("DEVICE_PCM_INVALID");
        while (item.queuedSamples + length > item.rate * maxQueuedSeconds) {
          await new Promise((resolve) => item.capacityWaiters.add(resolve));
          current(id);
        }
        const samples = new Float32Array(length), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
        item.queuedSamples += length;
        item.queue.push(samples);
        pump(item);
      },
      async play(id) {
        const item = current(id);
        await item.context.resume();
        if (item.stopped) return;
        item.playing = true;
        pump(item);
      },
      finish(id) {
        const item = current(id);
        item.finished = true;
        ended(item);
      },
      stop(id) {
        const item = players2.get(id);
        if (item) stop(item);
      },
      async dispose(id) {
        const item = players2.get(id);
        if (!item) return;
        stop(item);
        await item.context.close();
        players2.delete(id);
      }
    };
  }

  // runtime/renderer.mjs
  var players = /* @__PURE__ */ new Map();
  var send = (value) => window.audioDevice.send(value);
  var MAX_BYTES = 16 * 1024 * 1024;
  var capture = createCaptureRegistry({ mediaDevices: navigator.mediaDevices, AudioContext, AudioWorkletNode, send });
  var streams = createStreamPlayers({ AudioContext, send });
  function releasePlayer(id) {
    const item = players.get(id);
    if (!item) return;
    players.delete(id);
    item.stopped = true;
    item.playing = false;
    item.audio.onplaying = item.audio.ontimeupdate = item.audio.onended = item.audio.onerror = null;
    item.audio.pause();
    item.audio.removeAttribute("src");
    item.audio.load();
    URL.revokeObjectURL(item.url);
  }
  async function command(method, p) {
    if (method === "devices.list") return (await navigator.mediaDevices.enumerateDevices()).filter((d) => ["audioinput", "audiooutput"].includes(d.kind)).map((d) => ({ id: d.deviceId, kind: d.kind, label: d.label }));
    if (typeof p?.id !== "string" || p.id.length > 128) throw Error("DEVICE_ID_INVALID");
    if (method === "record.start") return capture.start(p);
    if (method === "record.mark") {
      capture.mark(p.id);
      return true;
    }
    if (method === "record.take") return { audio: audioBase64(encodeWave(capture.take(p.id))) };
    if (method === "record.dispose") {
      await capture.release(p.id);
      return true;
    }
    if (method === "player.stream.create") {
      await streams.create(p);
      return true;
    }
    if (method === "player.stream.append") {
      if (typeof p.audio !== "string" || p.audio.length > 35e4) throw Error("DEVICE_PCM_INVALID");
      await streams.append(p.id, Uint8Array.from(atob(p.audio), (c) => c.charCodeAt(0)));
      return true;
    }
    if (method === "player.stream.finish") {
      streams.finish(p.id);
      return true;
    }
    if (streams.has(p.id)) {
      if (method === "player.play") {
        await streams.play(p.id);
        return true;
      }
      if (method === "player.stop") {
        streams.stop(p.id);
        return true;
      }
      if (method === "player.dispose") {
        await streams.dispose(p.id);
        return true;
      }
    }
    if (method === "player.create") {
      if (players.size >= 4 || typeof p.audio !== "string" || p.audio.length > Math.ceil(MAX_BYTES / 3) * 4) throw Error("DEVICE_AUDIO_LIMIT");
      const bytes = Uint8Array.from(atob(p.audio), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })), audio = new Audio(url);
      try {
        if (p.outputDeviceId) await audio.setSinkId(p.outputDeviceId);
      } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
      }
      const item = { audio, url, stopped: false, playing: false };
      const current = () => players.get(p.id) === item && !item.stopped;
      const progress = () => {
        if (current() && item.playing && Number.isFinite(audio.currentTime) && audio.currentTime >= 0) send({ event: "player.progress", id: p.id, seconds: audio.currentTime });
      };
      audio.onplaying = () => {
        if (!current()) return;
        item.playing = true;
        progress();
      };
      audio.ontimeupdate = progress;
      audio.onended = () => {
        if (!current()) return;
        progress();
        item.stopped = true;
        item.playing = false;
        send({ event: "player.ended", id: p.id });
      };
      audio.onerror = () => {
        if (!current()) return;
        item.stopped = true;
        item.playing = false;
        send({ event: "player.error", id: p.id });
      };
      players.set(p.id, item);
      return true;
    }
    if (method === "player.play") {
      const item = players.get(p.id);
      if (!item) throw Error("DEVICE_PLAYER_MISSING");
      item.stopped = false;
      await item.audio.play();
      return true;
    }
    if (method === "player.stop") {
      const item = players.get(p.id);
      if (item) {
        item.stopped = true;
        item.playing = false;
        item.audio.pause();
      }
      return true;
    }
    if (method === "player.dispose") {
      releasePlayer(p.id);
      return true;
    }
    throw Error("DEVICE_METHOD_INVALID");
  }
  window.audioDevice.onCommand(async (request) => {
    try {
      send({ id: request.id, ok: true, value: await command(request.method, request.params) });
    } catch (error) {
      send({ id: request.id, ok: false, error: error instanceof Error ? error.message : "DEVICE_ERROR" });
    }
  });
  send({ event: "ready" });
})();
