import { randomBytes } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { lstat, mkdir, mkdtemp, open, realpath, rm, watch } from 'node:fs/promises';
import { request } from 'node:http';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { deviceEnvironment, spawnOwnedProcess } from './windows-job.mjs';

export { createResidentWake, normalizeWakeAliases, parseWakeAliases } from './resident-wake.mjs';
export { createResidentRecording } from './resident-recording.mjs';
export { createWakeListener } from './wake-listener.mjs';

const capturePath = '/v1/internal/assistant-';
const nonceValue = () => randomBytes(32).toString('hex');
const removeCaptureDirectory = directory => rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 });
const smallJson = (body, limit) => {
  if (body.length > limit) throw Error('ASSISTANT_SPEECH_RESPONSE_TOO_LARGE');
  return JSON.parse(body.toString('utf8'));
};

async function startupReceipt(path) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer);
    return smallJson(buffer.subarray(0, bytesRead), 4096);
  } finally { await file.close(); }
}

function waitForWorker(start, signal) {
  return new Promise((resolve, reject) => {
    const abort = addAbortListener(signal, () => reject(signal.reason));
    start.then(resolve, reject).finally(() => abort[Symbol.dispose]());
  });
}

/** A launcher-owned local capture process. Neither its endpoint nor its credential goes to a client. */
export function createManagedResidentSpeech({ executable, configPath, workspaceRoot, serviceRoot, dependenciesRoot, pythonHome, modelRoot, launch = spawnOwnedProcess }) {
  const validPath = value => typeof value === 'string' && isAbsolute(value);
  if (![executable, configPath, workspaceRoot].every(validPath)
      || ![serviceRoot, dependenciesRoot, pythonHome, modelRoot].every(value => value === undefined || validPath(value))) {
    throw Error('ASSISTANT_SPEECH_LOCAL_CONFIGURATION_REQUIRED');
  }
  const lifetime = new AbortController();
  let current, starting, closing;

  async function launchCapture() {
    await mkdir(workspaceRoot, { recursive: true });
    const [root, config, program] = await Promise.all([realpath(workspaceRoot), realpath(configPath), realpath(executable)]);
    const configRelative = relative(root, config);
    if (!configRelative || isAbsolute(configRelative) || configRelative === '..' || configRelative.startsWith('..' + sep)
        || !(await lstat(config)).isFile() || !(await lstat(program)).isFile()) {
      throw Error('ASSISTANT_SPEECH_LOCAL_CONFIGURATION_REQUIRED');
    }
    const service = await realpath(serviceRoot || dirname(dirname(program)));
    const entry = join(service, 'scripts', 'assistant_capture_host.py');
    if (!(await lstat(entry).catch(() => undefined))?.isFile()) throw Error('ASSISTANT_SPEECH_CAPTURE_HOST_MISSING');
    lifetime.signal.throwIfAborted();
    const directory = await mkdtemp(join(root, 'capture-'));
    const token = nonceValue(), nonce = nonceValue();
    const readyPath = join(directory, 'ready.json');
    const wakeAttempt = new AbortController();
    const timeout = AbortSignal.timeout(120_000);
    const startTimeout = AbortSignal.any([lifetime.signal, timeout, wakeAttempt.signal]);
    let process;
    try {
      const events = watch(directory, { signal: startTimeout });
      try {
        let change = events.next();
        void change.catch(() => {});
        const environment = deviceEnvironment();
        if (pythonHome) {
          const pathKey = Object.keys(environment).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
          environment[pathKey] = pythonHome + delimiter + (environment[pathKey] || '');
          environment.PYTHONHOME = pythonHome;
        }
        process = launch({ executable: program, cwd: directory, args: [entry], env: {
          ...environment, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1',
          RABISPEECH_ROOT: service, RABISPEECH_DEPS_ROOT: dependenciesRoot || join(service, '.deps'),
          RABISPEECH_HOST: '127.0.0.1', RABISPEECH_PORT: '0', RABISPEECH_CONFIG: config,
          RABISPEECH_ENDPOINT_NONCE: nonce, RABISPEECH_ASSISTANT_AUDIO_TOKEN: token,
          RABISPEECH_ASSISTANT_READY_FILE: readyPath, RABISPEECH_REMOTE_AUDIO_ENABLED: '0',
          RABISPEECH_TEMP_DIR: join(directory, 'temp'), RABISPEECH_PLAYBACK_DIR: join(directory, 'playback'),
          RABISPEECH_RECORDS_DIR: join(directory, 'records'), RABISPEECH_TTS_AUDIO_DIR: join(directory, 'tts'),
          RABISPEECH_REMOTE_AUDIO_SETTINGS: join(directory, 'remote-audio.json'),
          ...(modelRoot ? { RABISPEECH_MODEL_ROOT: modelRoot } : {}),
        } });
        for (;;) {
          const event = await change;
          if (event.done) throw Error('ASSISTANT_SPEECH_READY_INVALID');
          if (event.value.filename !== 'ready.json') {
            change = events.next();
            continue;
          }
          let ready;
          try { ready = await startupReceipt(readyPath); }
          catch (error) {
            if (error.code !== 'ENOENT') throw error;
            change = events.next();
            continue;
          }
          if (ready?.schemaVersion !== 1 || ready.mode !== 'assistant-capture' || ready.pid !== process.pid
              || ready.nonce !== nonce || ready.host !== '127.0.0.1'
              || !Number.isInteger(ready.port) || ready.port < 1024 || ready.port > 65535
              || process.exitCode() !== undefined) {
            throw Error('ASSISTANT_SPEECH_READY_INVALID');
          }
          return { directory, process, token, port: ready.port };
        }
      } finally {
        wakeAttempt.abort();
        await events.return();
      }
    } catch (error) {
      await process?.dispose();
      await removeCaptureDirectory(directory);
      if (timeout.aborted && !lifetime.signal.aborted) throw Error('ASSISTANT_SPEECH_START_TIMEOUT');
      throw error;
    }
  }

  async function retire(worker) {
    if (!worker) return;
    await worker.process.dispose();
    await removeCaptureDirectory(worker.directory);
    if (current === worker) current = undefined;
  }

  function worker() {
    lifetime.signal.throwIfAborted();
    starting ??= (async () => {
      if (current && current.process.exitCode() === undefined) return current;
      await retire(current);
      return current = await launchCapture();
    })().finally(() => { starting = undefined; });
    return starting;
  }

  async function send(operation, signal, query = '', body, type = 'application/json') {
    const combined = AbortSignal.any([signal, lifetime.signal]);
    combined.throwIfAborted();
    const { process, token, port } = await waitForWorker(worker(), combined);
    combined.throwIfAborted();
    if (process.exitCode() !== undefined) throw Error('ASSISTANT_SPEECH_WORKER_EXITED');
    return new Promise((resolve, reject) => {
      const call = request({ hostname: '127.0.0.1', port, path: capturePath + operation + query, signal: combined, agent: false,
        method: body === undefined ? 'GET' : 'POST', headers: {
          'x-rabispeech-assistant-token': token,
          ...(body === undefined ? {} : { 'content-type': type, 'content-length': Buffer.byteLength(body) }),
        } }, resolve);
      call.once('error', reject);
      call.end(body);
    });
  }

  return {
    openAssistantWake(aliases, signal) { return send('wake', signal, '', JSON.stringify({ aliases })); },
    openAssistantCapture(signal, cursor) {
      const query = cursor ? '?' + new URLSearchParams({ capture_id: cursor.captureId, from_sample: String(cursor.sample) }) : '';
      return send('capture', signal, query);
    },
    async setAssistantRealtime(captureId, enabled, signal) {
      const response = await send('realtime', signal, '', JSON.stringify({ captureId, enabled }));
      try {
        if (response.statusCode !== 200 && !(response.statusCode === 409 && !enabled)) throw Error('ASSISTANT_WAKE_HANDOFF_UNCONFIRMED');
      } finally { response.destroy(); }
    },
    async transcribeAssistantAudio(audio, signal) {
      if (!(audio instanceof Uint8Array) || audio.byteLength <= 44 || audio.byteLength > 44 + 35 * 16000 * 2) {
        throw Error('ASSISTANT_LOCAL_WAV_INVALID');
      }
      const response = await send('transcribe', signal, '', audio, 'audio/wav');
      try {
        if (response.statusCode !== 200 || response.headers['content-type'] !== 'application/json') throw Error('ASSISTANT_LOCAL_ASR_UNAVAILABLE');
        let total = 0;
        const chunks = [];
        for await (const chunk of response) {
          total += chunk.length;
          if (total > 256 * 1024) throw Error('ASSISTANT_SPEECH_RESPONSE_TOO_LARGE');
          chunks.push(chunk);
        }
        const result = smallJson(Buffer.concat(chunks, total), 256 * 1024);
        if (typeof result?.text !== 'string') throw Error('ASSISTANT_LOCAL_ASR_UNAVAILABLE');
        return result;
      } finally { response.destroy(); }
    },
    dispose() {
      if (closing) return closing;
      lifetime.abort();
      closing = (async () => { await starting?.catch(() => {}); await retire(current); })();
      return closing;
    },
  };
}
