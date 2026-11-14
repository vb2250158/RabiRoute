import { createTaskUtteranceBuffer, snapshotTaskInputPacket } from './task-input.js';

const failure = code => Object.assign(new Error(code), { code });

/** Own immutable batches while the injected receiver persists them.
 * Successful retention transfers ownership to that receiver's durable draft store. */
export function createTaskInputHandoffBuffer({ scope, createHandoffId, retain, onSettled = () => {},
  capacity = 32, ...inputOptions } = {}) {
  if (typeof createHandoffId !== 'function' || typeof retain !== 'function' || typeof onSettled !== 'function'
      || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 256) throw failure('TASK_HANDOFF_OPTIONS_INVALID');
  const records = new Map(), recentIds = new Set();
  let closed = false, lastOffered = null;

  function assertOpen() {
    if (closed) throw failure('TASK_HANDOFF_CLOSED');
  }
  function record(handoffId, packet) {
    if (typeof handoffId !== 'string' || !handoffId.trim() || handoffId.length > 512) throw failure('TASK_HANDOFF_ID_INVALID');
    if (records.size >= capacity) throw failure('TASK_HANDOFF_FULL');
    const entry = { handoffId, packet, status: 'unconfirmed', completion: null };
    records.set(handoffId, entry);
    recentIds.add(handoffId);
    if (recentIds.size > 256) recentIds.delete(recentIds.values().next().value);
    return entry;
  }
  function save(entry) {
    entry.status = 'retaining';
    entry.completion = Promise.resolve().then(() => retain({
      handoffId: entry.handoffId, scope: entry.packet.scope, text: entry.packet.text
    })).then(receipt => {
      if (receipt?.status !== 'retained' || receipt.handoffId !== entry.handoffId) throw failure('TASK_HANDOFF_RECEIPT_INVALID');
      entry.status = 'retained';
      records.delete(entry.handoffId);
      return { status: 'retained', handoffId: entry.handoffId, packet: entry.packet };
    }).catch(error => {
      entry.status = 'unconfirmed';
      return { status: 'unconfirmed', handoffId: entry.handoffId, packet: entry.packet,
        code: typeof error?.code === 'string' ? error.code : 'TASK_HANDOFF_UNCONFIRMED' };
    }).then(result => {
      if (!closed) {
        try { onSettled(result); }
        catch (_) { return { ...result, notificationError: 'TASK_HANDOFF_NOTIFICATION_FAILED' }; }
      }
      return result;
    });
    return entry.completion;
  }
  const buffer = createTaskUtteranceBuffer({ ...inputOptions, scope, onReady(packet) {
    if (closed || records.size >= capacity) return false;
    const id = createHandoffId();
    if (recentIds.has(id)) throw failure('TASK_HANDOFF_ID_REUSED');
    const entry = record(id, packet);
    lastOffered = entry;
    save(entry);
    // Ownership moved to records above. Durable completion remains in its Promise.
    return true;
  } });
  const handoffs = () => [...records.values()].map(entry => Object.freeze({
    handoffId: entry.handoffId, packet: entry.packet, status: entry.status, completion: entry.completion
  }));
  return Object.freeze({
    ...buffer,
    flush() {
      const result = buffer.flush();
      return result.accepted ? lastOffered.completion : Promise.resolve(result);
    },
    retryHandoff(id) {
      assertOpen();
      const entry = records.get(id);
      if (!entry) throw failure('TASK_HANDOFF_NOT_FOUND');
      return entry.status === 'retaining' ? entry.completion : save(entry);
    },
    restoreHandoff({ handoffId, packet } = {}) {
      assertOpen();
      const snapshot = snapshotTaskInputPacket(packet, scope);
      const existing = records.get(handoffId);
      if (existing) {
        if (JSON.stringify(existing.packet) !== JSON.stringify(snapshot)) throw failure('TASK_HANDOFF_ID_CONFLICT');
        return;
      }
      if (recentIds.has(handoffId)) throw failure('TASK_HANDOFF_ID_REUSED');
      const entry = record(handoffId, snapshot);
      entry.completion = Promise.resolve({ status: 'unconfirmed', handoffId, packet: snapshot, code: 'TASK_HANDOFF_RESTORED' });
    },
    handoffs,
    dispose() {
      closed = true;
      return { draft: buffer.dispose(), handoffs: handoffs() };
    },
    getState() { return { ...buffer.getState(), handoffs: records.size }; }
  });
}
