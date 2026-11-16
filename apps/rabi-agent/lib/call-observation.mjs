import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const context = new AsyncLocalStorage();
const secretField = /authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key|credential|signature/i;

/** Observations are sanitized before either local spooling or Manager persistence. */
export function redactCallValue(value, depth = 0, visited = new WeakSet(), secrets = []) {
  if (depth > 24) return '[depth limit]';
  if (typeof value === 'string') {
    for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]');
    if (/^[\s]*[\[{]/.test(value)) {
      if (value.length >= 8 * 1024 * 1024) return { captured: 'omitted', reason: 'payload-budget' };
      try { return JSON.stringify(redactCallValue(JSON.parse(value), depth + 1, visited, secrets)); }
      catch { return { captured: 'omitted', reason: 'unparseable-json' }; }
    }
    let text = value.replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
      .replace(/(["']?(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key|credential|signature)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]');
    return text;
  }
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return { mediaType: 'application/octet-stream', bytes: value.byteLength, captured: 'metadata' };
  if (visited.has(value)) return '[circular]';
  visited.add(value);
  const result = Array.isArray(value)
    ? value.map(item => redactCallValue(item, depth + 1, visited, secrets))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretField.test(key) ? '[redacted]' : redactCallValue(item, depth + 1, visited, secrets)]));
  visited.delete(value);
  return result;
}

export function currentCallObservation() { return context.getStore(); }

function state(receipt) {
  if (receipt?.uncertain) return 'uncertain';
  if (receipt?.transportError === 'CANCELLED') return 'cancelled';
  if (receipt?.ok === false || receipt?.isError === true || receipt?.statusCode >= 400) return 'failed';
  if (['running', 'open'].includes(receipt?.state)) return 'running';
  return receipt?.statusCode === 202 ? 'accepted' : 'succeeded';
}

/** Completed client observations remain in this outbox until the Manager acknowledges them. */
export function createClientCallRecorder({ source, directory, targetKey, send, redactValues = [], flushBudgetMs = 1500 }) {
  if (typeof targetKey !== 'string' || !targetKey || !Number.isSafeInteger(flushBudgetMs) || flushBudgetMs < 1) throw new TypeError('Invalid call recorder target or flush budget.');
  const base = directory ?? path.join(os.homedir(), '.rabiroute', 'call-history');
  const rootFor = key => path.join(base, createHash('sha256').update(key).digest('hex').slice(0, 24));
  const pendingFiles = new Map();
  let currentTarget = targetKey;
  let writing = Promise.resolve();
  let flight;
  let flightController;
  let closing;
  let stopped = false;

  async function bounded(action, signal) {
    signal.throwIfAborted();
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try { return await Promise.race([Promise.resolve().then(action), interrupted]); }
    finally { signal.removeEventListener('abort', abort); }
  }

  function validObservation(value, target) {
    return value && typeof value === 'object' && typeof value.callId === 'string' && typeof value.spanId === 'string'
      && ['client', 'tool'].includes(value.boundary) && typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt))
      && typeof value.status === 'string' && value.target?.key === target;
  }

  async function quarantine(file) {
    try { await fs.rename(file, file + '.' + randomUUID() + '.invalid'); }
    catch { /* Preserve a file whose quarantine move failed and continue its healthy neighbors. */ }
  }

  function flush({ signal, budgetMs = flushBudgetMs } = {}) {
    if (flight || stopped) return flight ?? Promise.resolve();
    const controller = new AbortController();
    flightController = controller;
    const deadline = setTimeout(() => controller.abort(new DOMException('Call-history flush deadline exceeded.', 'TimeoutError')), budgetMs);
    const cancellation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const selectedTarget = currentTarget;
    flight = (async () => {
      try {
        await bounded(() => writing, cancellation);
        const root = rootFor(selectedTarget);
        const seen = new Set();
        while (seen.size < 16 && selectedTarget === currentTarget) {
          let files;
          try { files = await bounded(() => fs.readdir(root), cancellation); }
          catch { return; }
          const pending = pendingFiles.get(selectedTarget);
          files = files.filter(name => /^[a-f0-9]{64}\.json$/.test(name) && !seen.has(name))
            .sort((left, right) => Number(Boolean(pending?.has(right))) - Number(Boolean(pending?.has(left))));
          if (!files.length) break;
          for (const name of files.slice(0, 16 - seen.size)) {
            if (selectedTarget !== currentTarget) return;
            cancellation.throwIfAborted();
            seen.add(name);
            const file = path.join(root, name);
            let observation;
            try { observation = JSON.parse(await bounded(() => fs.readFile(file, 'utf8'), cancellation)); }
            catch (error) {
              if (cancellation.aborted) throw error;
              await bounded(() => quarantine(file), cancellation);
              pending?.delete(name);
              continue;
            }
            if (!validObservation(observation, selectedTarget)) {
              await bounded(() => quarantine(file), cancellation);
              pending?.delete(name);
              continue;
            }
            let receipt;
            try { receipt = await bounded(() => send(observation, { signal: cancellation }), cancellation); }
            catch { return; }
            if (receipt.transportError || !receipt.statusCode && receipt.ok === false || receipt.statusCode >= 500
              || [401, 403, 404, 408, 409, 429].includes(receipt.statusCode)) return;
            if ([400, 422].includes(receipt.statusCode)) {
              await bounded(() => quarantine(file), cancellation);
              pending?.delete(name);
              continue;
            }
            let body;
            try { body = receipt.bodyJson ?? JSON.parse(receipt.body); } catch { continue; }
            if (!receipt.ok || body?.data?.stored !== true) continue;
            await bounded(() => fs.unlink(file), cancellation);
            pending?.delete(name);
          }
        }
      } catch { /* A bounded diagnostic transfer leaves unacknowledged observations in the outbox. */ }
    })().finally(() => {
      clearTimeout(deadline);
      if (flightController === controller) flightController = undefined;
      flight = undefined;
    });
    return flight;
  }

  function save(observation) {
    try {
      const selectedTarget = observation.target.key;
      const snapshot = { ...observation, target: { key: selectedTarget } };
      let safe = JSON.stringify(redactCallValue(snapshot, 0, new WeakSet(), redactValues));
      if (Buffer.byteLength(safe) > 8 * 1024 * 1024) {
        const { request, response, ...metadata } = snapshot;
        safe = JSON.stringify(redactCallValue({ ...metadata, truncated: true, request: { captured: 'payload-budget' }, response: { captured: 'payload-budget' } }, 0, new WeakSet(), redactValues));
      }
      const name = createHash('sha256').update(observation.callId + ':' + observation.spanId).digest('hex') + '.json';
      const root = rootFor(selectedTarget);
      writing = writing.then(async () => {
        await fs.mkdir(root, { recursive: true });
        const temporary = path.join(root, name + '.' + randomUUID() + '.tmp');
        await fs.writeFile(temporary, safe, { mode: 0o600 });
        await fs.rename(temporary, path.join(root, name));
        let pending = pendingFiles.get(selectedTarget);
        if (!pending) pendingFiles.set(selectedTarget, pending = new Set());
        pending.add(name);
      }).catch(() => {});
      void writing.then(() => flush());
    } catch { /* Observation extraction, serialization and filesystem errors preserve the original result. */ }
  }

  return {
    async run(metadata, action) {
      const parent = context.getStore();
      let observation;
      try {
        observation = { ...metadata, source, callId: parent?.callId ?? randomUUID(), spanId: randomUUID(),
          target: parent?.target ?? { key: currentTarget }, toolName: metadata.toolName ?? parent?.toolName, startedAt: new Date().toISOString() };
      } catch { return action(); }
      return context.run(observation, async () => {
        let response;
        try {
          response = await action();
        } catch (error) {
          try {
            save({ ...observation, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(observation.startedAt),
              status: error?.name === 'AbortError' ? 'cancelled' : 'failed', response: { error: error?.name ?? 'Error', message: 'Client invocation failed before a result was available.' } });
          } catch { /* Preserve even an exception with throwing diagnostic getters. */ }
          throw error;
        }
        try {
          save({ ...observation, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(observation.startedAt),
            status: state(response), statusCode: response?.statusCode, responseBytes: response?.bytesReceived,
            requestId: response?.headers?.['x-rabiroute-request-id'], response });
        } catch { /* A successful business return survives diagnostic getter failures. */ }
        return response;
      });
    },
    setTarget(key) {
      if (typeof key !== 'string' || !key) return;
      if (key !== currentTarget) flightController?.abort(new DOMException('Call-history target changed.', 'AbortError'));
      currentTarget = key;
      const active = context.getStore();
      if (active?.target) active.target.key = key;
    },
    close() {
      if (closing) return closing;
      const controller = new AbortController();
      const deadlineAt = performance.now() + flushBudgetMs;
      const timer = setTimeout(() => controller.abort(new DOMException('Call-history close deadline exceeded.', 'TimeoutError')), flushBudgetMs);
      closing = (async () => {
        try {
          await bounded(() => writing, controller.signal);
          if (flight) await bounded(() => flight, controller.signal);
          const remaining = Math.max(1, Math.ceil(deadlineAt - performance.now()));
          await flush({ signal: controller.signal, budgetMs: remaining });
        } catch { /* The durable outbox owns later recovery. */ }
        finally {
          stopped = true;
          clearTimeout(timer);
          flightController?.abort(new DOMException('Call-history recorder closed.', 'AbortError'));
        }
      })();
      return closing;
    },
    flush
  };
}
