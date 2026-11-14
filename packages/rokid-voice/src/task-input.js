const invalid = code => { throw Object.assign(new Error(code), { code }); };
const textOf = value => typeof value === 'string' && value.trim() ? value : '';
function interval(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 60000) invalid('TASK_INPUT_INTERVAL_INVALID');
  return value;
}

/** Validate both current raw-text packets and previously normalized saved drafts. */
export function snapshotTaskInputPacket(packet, scope) {
  if (!packet || packet.scope !== scope || !Array.isArray(packet.segments)
      || !packet.segments.length || packet.segments.length > 64) invalid('TASK_INPUT_DRAFT_INVALID');
  const segments = [], ids = new Set();
  for (const segment of packet.segments) {
    const text = textOf(segment?.text), resultId = segment?.resultId;
    if (!text || typeof resultId !== 'string' || !resultId.trim() || resultId.length > 256 || ids.has(resultId)) invalid('TASK_INPUT_DRAFT_INVALID');
    ids.add(resultId);
    segments.push(Object.freeze({ resultId, text }));
  }
  const text = segments.map(value => value.text).join(' ');
  if (text.length > 16000 || text !== packet.text) invalid('TASK_INPUT_DRAFT_INVALID');
  return Object.freeze({ scope, silenceMs: interval(packet.silenceMs), text, segments: Object.freeze(segments) });
}

/** One foreground task binding. The receiver owns delivery; this buffer never calls a backend. */
export function createTaskUtteranceBuffer({ scope, silenceMs = 5000, onReady, onInterrupt = () => {},
  schedule = (fn, ms) => setTimeout(fn, ms), unschedule = id => clearTimeout(id) } = {}) {
  if (typeof scope !== 'string' || !scope.trim() || scope.length > 1024
      || [onReady, onInterrupt, schedule, unschedule].some(value => typeof value !== 'function')) invalid('TASK_INPUT_DEPENDENCIES_REQUIRED');
  let configured = interval(silenceMs), batch = null, speaking = false, closed = false, timer = null, epoch = 0;
  let reason = '', offering = false;
  const seen = new Map();
  const clear = () => { epoch++; if (timer !== null) unschedule(timer); timer = null; };
  const start = () => batch ||= { silenceMs: configured, segments: [], chars: 0, interim: false };
  const snapshot = () => batch?.segments.length ? Object.freeze({ scope, silenceMs: batch.silenceMs,
    text: batch.segments.map(value => value.text).join(' '),
    segments: Object.freeze(batch.segments.map(value => Object.freeze({ ...value }))) }) : null;
  function offer() {
    if (closed) return { accepted: false, reason: 'closed' };
    if (offering) return { accepted: false, reason: 'offering' };
    if (speaking || batch?.interim) return { accepted: false, reason: 'speaking' };
    clear();
    const packet = snapshot();
    if (!packet) { batch = null; reason = ''; return { accepted: false, reason: 'empty' }; }
    const owner = batch;
    offering = true;
    let accepted = false;
    try {
      const result = onReady(packet);
      // The callback transfers ownership synchronously to a queue, not to a remote API.
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        reason = 'async-receiver';
      } else { accepted = result === true; reason = accepted ? '' : 'receiver-busy'; }
    } catch (_) { reason = 'receiver-error'; }
    finally { offering = false; }
    if (accepted && batch === owner) batch = null;
    return accepted ? { accepted: true } : { accepted: false, reason };
  }
  function arm() {
    clear();
    if (closed || !batch || speaking || batch.interim || reason) return;
    const ownerEpoch = epoch;
    timer = schedule(() => { if (!closed && ownerEpoch === epoch) { timer = null; offer(); } }, batch.silenceMs);
  }
  function interrupt() {
    // Playback ownership remains outside the task input queue.
    try { onInterrupt(); } catch (_) { clear(); reason = 'interrupt-error'; }
  }
  return Object.freeze({
    speechStart() {
      if (closed || offering) return false;
      clear(); start(); speaking = true; interrupt(); return true;
    },
    speechEnd() {
      if (closed || offering) return false;
      speaking = false; arm(); return true;
    },
    interim(text) {
      if (closed || offering || !textOf(text)) return false;
      clear(); start().interim = true; interrupt(); return true;
    },
    final({ resultId, text } = {}) {
      if (closed || offering) return { accepted: false, reason: closed ? 'closed' : 'offering' };
      const value = textOf(text);
      if (typeof resultId !== 'string' || !resultId.trim() || resultId.length > 256 || !value) invalid('TASK_INPUT_SEGMENT_INVALID');
      if (seen.has(resultId)) {
        if (seen.get(resultId) !== value) invalid('TASK_INPUT_SEGMENT_CONFLICT');
        return { accepted: true, duplicate: true };
      }
      const owner = start();
      if (owner.segments.length >= 64 || owner.chars + value.length + (owner.segments.length ? 1 : 0) > 16000) {
        // Retain the accepted prefix, but never automatically dispatch a truncated command.
        clear(); reason = 'input-full'; return { accepted: false, reason };
      }
      owner.chars += value.length + (owner.segments.length ? 1 : 0);
      owner.segments.push({ resultId, text: value }); owner.interim = false;
      seen.set(resultId, value); if (seen.size > 128) seen.delete(seen.keys().next().value);
      interrupt(); arm(); return { accepted: true };
    },
    configure({ silenceMs: next } = {}) {
      if (closed) invalid('TASK_INPUT_CLOSED');
      configured = interval(next);
      return { silenceMs: configured, deferred: Boolean(batch) };
    },
    restoreDraft(packet) {
      if (closed) invalid('TASK_INPUT_CLOSED');
      if (batch || offering) invalid('TASK_INPUT_DRAFT_INVALID');
      const restored = snapshotTaskInputPacket(packet, scope);
      batch = { silenceMs: restored.silenceMs, segments: [...restored.segments], chars: restored.text.length, interim: false };
      for (const segment of restored.segments) seen.set(segment.resultId, segment.text);
      reason = 'restored-draft'; // Explicit submit/resume is required; re-opening never sends it.
    },
    resumeDraft() {
      if (closed) invalid('TASK_INPUT_CLOSED');
      if (offering) return false;
      reason = ''; arm(); return true;
    },
    flush: offer,
    peek: snapshot,
    dispose() {
      const pending = snapshot(); closed = true; clear(); batch = null; seen.clear(); return pending;
    },
    getState() { return { closed, speaking, pendingInterim: Boolean(batch?.interim), segments: batch?.segments.length || 0,
      silenceMs: batch?.silenceMs ?? configured, configuredSilenceMs: configured, retainedReason: reason }; }
  });
}
