import { canonicalAgentIntent, snapshotTaskObservation } from './decision-protocol.js';
import { checkCurrent } from './assert-current.js';
import { unavailableInterjection } from './interjection.js';

const failure = code => Object.assign(new Error(code), { code });
const cancelledTurn = () => ({ state: 'cancelled', text: '', toolResults: [] });

/** One foreground model, with adapter-owned background tasks and durable receipts.
 * The caller transfers exclusive session scheduling to this owner. */
export function createAssistantConversation({ session, scope, receipts, capacity = 32, receiptTimeoutMs = 5000 } = {}) {
  if (typeof session?.run !== 'function' || typeof session.observe !== 'function'
      || typeof session.dispose !== 'function' || typeof session.guide !== 'function'
      || typeof scope !== 'string' || !scope.trim() || scope.length > 512
      || typeof receipts?.has !== 'function' || typeof receipts.acknowledge !== 'function'
      || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 256
      || !Number.isSafeInteger(receiptTimeoutMs) || receiptTimeoutMs < 1 || receiptTimeoutMs > 30000) {
    throw failure('ASSISTANT_CONVERSATION_OPTIONS_INVALID');
  }
  const users = [], observations = [], records = new Map();
  let closed = false, listening = false, active = null, scheduled = false;

  async function receipt(action) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('ASSISTANT_RECEIPT_TIMEOUT')), receiptTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  function assertOpen() {
    if (closed) throw failure('ASSISTANT_CONVERSATION_CLOSED');
  }
  function assertCapacity(kind) {
    const size = kind === 'user' ? users.length + (active?.kind === 'user' ? 1 : 0) : records.size;
    if (size >= capacity) {
      throw failure('ASSISTANT_CONVERSATION_FULL');
    }
  }
  function job(kind, input, options) {
    let resolve, reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    return { kind, input, options, promise, resolve, reject, result: null, acknowledgement: null };
  }
  function schedule() {
    if (scheduled || active || closed) return;
    scheduled = true;
    // A same-tick foreground input takes priority over a background update.
    Promise.resolve().then(() => {
      scheduled = false;
      void drain();
    });
  }
  async function drain() {
    if (closed || active) return;
    const next = users.shift() || (!listening && observations.shift());
    if (!next) return;
    active = next;
    try {
      if (next.kind === 'user') {
        checkCurrent(next.options.assertCurrent);
        next.resolve(await session.run(next.input, next.options));
        return;
      }
      const result = await session.observe(next.input, { onText() {}, onState() {} });
      if (closed || result.state === 'cancelled') {
        records.delete(next.input.id);
        next.resolve({ status: 'cancelled', observation: next.input });
        return;
      }
      if (result.state !== 'completed') throw failure('ASSISTANT_OBSERVATION_UNCONFIRMED');
      // Generation and display acknowledgement are separate. Retain the result
      // until the caller confirms presentation through its durable receipt owner.
      next.result = { status: 'processed', observation: next.input, result };
      next.resolve(next.result);
    } catch (error) {
      if (next.kind === 'observation') records.delete(next.input.id);
      if (next.kind === 'user') {
        const retained = new Error(typeof error?.message === 'string' ? error.message : 'ASSISTANT_RUN_FAILED');
        retained.code = typeof error?.code === 'string' ? error.code : 'ASSISTANT_RUN_FAILED';
        retained.cause = error;
        retained.originalInput = next.input;
        if (Array.isArray(error?.pendingGuidance)) retained.pendingGuidance = [...error.pendingGuidance];
        next.reject(retained);
      } else next.reject(error);
    } finally {
      active = null;
      schedule();
    }
  }
  return Object.freeze({
    supportsTurnGuard: session.supportsTurnGuard === true,
    supportsInterjectionReceipts: session.supportsInterjectionReceipts === true && typeof session.interject === 'function',
    run(text, options = {}) {
      assertOpen();
      if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw failure('TURN_INPUT_INVALID');
      if (!options || typeof options !== 'object' || Array.isArray(options)
          || (options.assertCurrent !== undefined && typeof options.assertCurrent !== 'function')
          || (options.limits !== undefined && (!options.limits || typeof options.limits !== 'object' || Array.isArray(options.limits)))) throw failure('ASSISTANT_RUN_OPTIONS_INVALID');
      if (options.assertCurrent !== undefined && session.supportsTurnGuard !== true) throw failure('ASSISTANT_TURN_GUARD_UNSUPPORTED');
      assertCapacity('user');
      const entry = job('user', text, { ...options, limits: options.limits === undefined ? undefined : { ...options.limits } });
      users.push(entry);
      schedule();
      return entry.promise;
    },
    guide(text) {
      assertOpen();
      if (active?.kind !== 'user') return { accepted: false, reason: 'idle' };
      return session.guide(text);
    },
    interject(input, options) {
      if (closed || active?.kind !== 'user' || session.supportsInterjectionReceipts !== true || typeof session.interject !== 'function') {
        return unavailableInterjection(input, options, 'ASSISTANT_INTERJECTION_UNAVAILABLE');
      }
      return session.interject(input, options);
    },
    observe(value) {
      assertOpen();
      const observation = snapshotTaskObservation(value);
      if (observation.scope !== scope) throw failure('ASSISTANT_OBSERVATION_SCOPE_MISMATCH');
      const existing = records.get(observation.id);
      if (existing) {
        if (canonicalAgentIntent(existing.input) !== canonicalAgentIntent(observation)) throw failure('ASSISTANT_OBSERVATION_ID_CONFLICT');
        return existing.promise;
      }
      assertCapacity('observation');
      const entry = job('observation', observation);
      records.set(observation.id, entry);
      // Receipt I/O never occupies the foreground model or delays user input.
      receipt(() => receipts.has(scope, observation.id)).then(acknowledged => {
        if (typeof acknowledged !== 'boolean') throw failure('ASSISTANT_RECEIPT_INVALID');
        if (closed) return;
        if (acknowledged) {
          records.delete(observation.id);
          entry.resolve({ status: 'acknowledged', observation });
          return;
        }
        observations.push(entry);
        schedule();
      }).catch(error => {
        records.delete(observation.id);
        entry.reject(error);
      });
      return entry.promise;
    },
    acknowledge(id) {
      assertOpen();
      const entry = records.get(id);
      if (!entry?.result) throw failure('ASSISTANT_OBSERVATION_NOT_PROCESSED');
      if (entry.acknowledgement) return entry.acknowledgement;
      entry.acknowledgement = receipt(() => receipts.acknowledge(scope, id)).then(confirmed => {
        if (confirmed !== true) throw failure('ASSISTANT_RECEIPT_UNCONFIRMED');
        records.delete(id);
        return { acknowledged: true };
      }).finally(() => { entry.acknowledgement = null; });
      return entry.acknowledgement;
    },
    setListening(value) {
      assertOpen();
      if (typeof value !== 'boolean') throw failure('ASSISTANT_LISTENING_INVALID');
      listening = value;
      if (!listening) schedule();
    },
    dispose() {
      if (closed) return;
      closed = true;
      for (const entry of users.splice(0)) entry.resolve(cancelledTurn());
      for (const entry of records.values()) entry.resolve({ status: 'cancelled', observation: entry.input });
      observations.length = 0;
      records.clear();
      session.dispose();
    },
    getState() {
      return { closed, listening, active: active?.kind || null, queuedUsers: users.length,
        queuedObservations: observations.length, retainedObservations: records.size };
    }
  });
}
