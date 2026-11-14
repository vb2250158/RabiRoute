import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnOwnedProcess, deviceEnvironment } from './windows-job.mjs';

const MAX_FRAME = 24 * 1024 * 1024;
const defaultRuntime = fileURLToPath(new URL('../runtime/main.cjs', import.meta.url));
/** Private, bounded IPC. No HTTP listener, provider keys or inherited Host handles. */
export async function openDesktopDevice({ electronExecutable, runtimeEntry = defaultRuntime, signal,
  inputDeviceId = '', outputDeviceId = '', maxDurationMs = 30000, onEvent = () => {}, startTimeoutMs = 20000 }) {
  signal?.throwIfAborted();
  const pipe = '\\\\.\\pipe\\voice-device-' + randomUUID(), nonce = randomBytes(32).toString('hex');
  const userData = await mkdtemp(join(tmpdir(), 'voice-device-'));
  let socket, child, closed = false, closing, sequence = 0, readiness, watcher;
  const pending = new Map(), records = new Map(), players = new Map(), connections = new Set();
  let captureRelease = Promise.resolve();
  const notify = event => { try { Promise.resolve(onEvent(event)).catch(() => {}); } catch {} };
  const recordError = (record, error) => { try { Promise.resolve(record?.onError?.(error)).catch(() => {}); } catch {} };
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  const rejectPending = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  const close = () => {
    if (closing) return closing;
    closed = true; clearTimeout(readiness); clearInterval(watcher); signal?.removeEventListener('abort', abort);
    const error = Error('DEVICE_CLOSED'); rejectReady(error); rejectPending(error);
    for (const connection of connections) connection.destroy();
    server.close();
    closing = (async () => {
      await child?.dispose();
      try { await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
      catch { notify({ type: 'temporary-cache-retained' }); }
    })();
    return closing;
  };
  const fail = error => {
    rejectReady(error); rejectPending(error);
    for (const record of records.values()) recordError(record, error);
    notify({ type: 'device-error', error: error.message });
    void close().catch(error => notify({ type: 'cleanup-error', error: error.message }));
  };
  const abort = () => { void close().catch(error => notify({ type: 'cleanup-error', error: error.message })); };
  const receive = message => {
    if (message.event === 'ready') { clearTimeout(readiness); resolveReady(); return; }
    if (message.event === 'record.level') {
      const record = records.get(message.id); if (record && Number.isFinite(message.value)) record.level = message.value; return;
    }
    if (message.event === 'record.error') { recordError(records.get(message.id), Error('DEVICE_CAPTURE_INTERRUPTED')); return; }
    if (message.event === 'record.pcm') {
      const record = records.get(message.id);
      if (!record?.onPcm) return;
      if (typeof message.audio !== 'string' || message.audio.length > 48000) { recordError(record, Error('DEVICE_PCM_INVALID')); return; }
      const audio = Buffer.from(message.audio, 'base64');
      if (!audio.length || audio.length % 2) { recordError(record, Error('DEVICE_PCM_INVALID')); return; }
      try { Promise.resolve(record.onPcm(audio)).catch(error => recordError(record, error)); } catch (error) { recordError(record, error); }
      return;
    }
    if (message.event === 'player.ended' || message.event === 'player.error') {
      const player = players.get(message.id);
      if (player) {
        const ended = message.event === 'player.ended';
        player.dispatchEvent(new Event(ended ? 'ended' : 'error'));
        notify({ type: ended ? 'playback-ended' : 'playback-error' });
      }
      return;
    }
    if (message.event === 'presenter.action' || message.event === 'presenter.bounds') { notify(message); return; }
    const item = pending.get(message.id); if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.ok === true) item.resolve(message.value); else item.reject(Error(typeof message.error === 'string' ? message.error.slice(0, 160) : 'DEVICE_REQUEST_FAILED'));
  };
  const server = createServer(connection => {
    if (closed || connections.size >= 4) { connection.destroy(); return; }
    connections.add(connection); let authenticated = false, buffer = '';
    const authTimer = setTimeout(() => connection.destroy(), 2000);
    connection.setEncoding('utf8');
    connection.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME) { connection.destroy(); if (authenticated) fail(Error('DEVICE_FRAME_LIMIT')); return; }
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try {
          const message = JSON.parse(line);
          if (!authenticated) {
            if (socket || message.auth !== nonce) { connection.destroy(); return; }
            authenticated = true; socket = connection; clearTimeout(authTimer); continue;
          }
          if (!closed) receive(message);
        } catch { connection.destroy(); if (authenticated) fail(Error('DEVICE_PROTOCOL_INVALID')); return; }
      }
    });
    connection.on('error', () => {});
    connection.on('close', () => {
      clearTimeout(authTimer); connections.delete(connection);
      if (authenticated && !closed) fail(Error('DEVICE_DISCONNECTED'));
    });
  });
  const request = (method, params = {}, timeoutMs = 15000) => {
    if (closed || !socket) return Promise.reject(Error('DEVICE_CLOSED'));
    if (pending.size >= 32 || socket.writableLength > MAX_FRAME) return Promise.reject(Error('DEVICE_QUEUE_LIMIT'));
    const id = ++sequence, frame = JSON.stringify({ id, method, params }) + '\n';
    if (frame.length > MAX_FRAME) return Promise.reject(Error('DEVICE_FRAME_LIMIT'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id); reject(Error('DEVICE_REQUEST_TIMEOUT'));
        // A timed-out device mutation has uncertain ownership: stop this device
        // instead of replaying the command or acquiring a replacement.
        fail(Error('DEVICE_REQUEST_TIMEOUT'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.write(frame, error => { if (error) fail(Error('DEVICE_WRITE_FAILED')); });
    });
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
    signal?.throwIfAborted();
    child = spawnOwnedProcess({ executable: electronExecutable, args: [resolve(runtimeEntry), '--voice-pipe=' + pipe, '--voice-nonce=' + nonce, '--voice-user-data=' + userData],
      cwd: dirname(resolve(runtimeEntry)), env: deviceEnvironment() });
    signal?.addEventListener('abort', abort, { once: true });
    readiness = setTimeout(() => fail(Error('DEVICE_START_TIMEOUT')), startTimeoutMs);
    watcher = setInterval(() => { try { if (!closed && child.exitCode() !== undefined) fail(Error('DEVICE_PROCESS_EXITED')); } catch { fail(Error('DEVICE_PROCESS_STATUS_FAILED')); } }, 100);
    await ready;
    return {
      pid: child.pid, request, close,
      enumerateDevices: () => request('devices.list'),
      configurePresenter: settings => request('presenter.configure', settings),
      present: value => request('presenter.update', value),
      createRecording() {
        const id = randomUUID(), record = { level: 0, onError: null }; records.set(id, record);
        let disposed;
        return {
          async start(onError, { onPcm } = {}) {
            record.onError = onError;
            record.onPcm = onPcm;
            await captureRelease;
            if (disposed) throw Error('DEVICE_CAPTURE_CANCELLED');
            await request('record.start', { id, inputDeviceId, maxDurationMs, streaming: typeof onPcm === 'function' });
          },
          amplitude: () => record.level,
          async take() { const result = await request('record.take', { id }); return Buffer.from(result.audio, 'base64'); },
          markSpeech() { void request('record.mark', { id }).catch(error => recordError(record, error)); },
          async stop() { const result = await request('record.take', { id }); return Buffer.from(result.audio, 'base64'); },
          dispose() {
            if (disposed) return disposed;
            records.delete(id);
            disposed = closed ? Promise.resolve() : request('record.dispose', { id });
            captureRelease = disposed;
            void captureRelease.catch(() => {});
            return disposed;
          },
        };
      },
      async createPlayer(bytes) {
        const id = randomUUID(), events = new EventTarget(); players.set(id, events);
        try { await request('player.create', { id, audio: Buffer.from(bytes).toString('base64'), outputDeviceId }); }
        catch (error) { players.delete(id); throw error; }
        let destroyed;
        return { events, play: () => request('player.play', { id }), stop: () => request('player.stop', { id }),
          destroy() { if (!destroyed) { players.delete(id); destroyed = closed ? Promise.resolve() : request('player.dispose', { id }); } return destroyed; } };
      },
      async createStreamPlayer({ sampleRate = 24000 } = {}) {
        const id = randomUUID(), events = new EventTarget(); players.set(id, events);
        try { await request('player.stream.create', { id, sampleRate, outputDeviceId }); }
        catch (error) { players.delete(id); throw error; }
        let destroyed, stopped = false, chain = Promise.resolve(), queuedBytes = 0;
        return { events,
          append(bytes) {
            if (stopped || destroyed) return Promise.reject(Error('DEVICE_STREAM_STOPPED'));
            if (!(bytes instanceof Uint8Array) || queuedBytes + bytes.length > 2 * 1024 * 1024) return Promise.reject(Error('DEVICE_PLAYBACK_BACKLOG'));
            queuedBytes += bytes.length;
            const operation = chain.then(() => {
              if (stopped || destroyed) return;
              return request('player.stream.append', { id, audio: Buffer.from(bytes).toString('base64') });
            }).finally(() => { queuedBytes -= bytes.length; });
            chain = operation.catch(() => {}); return operation;
          },
          finish: () => chain.then(() => stopped || destroyed ? undefined : request('player.stream.finish', { id })),
          play: () => stopped || destroyed ? Promise.reject(Error('DEVICE_STREAM_STOPPED')) : request('player.play', { id }),
          stop() { stopped = true; return closed ? Promise.resolve() : request('player.stop', { id }); },
          destroy() { stopped = true; if (!destroyed) { players.delete(id); destroyed = closed ? Promise.resolve() : request('player.dispose', { id }); } return destroyed; },
        };
      },
    };
  } catch (error) { await close(); throw error; }
}
