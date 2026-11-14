const failure = code => Object.assign(new Error(code), { code });
const copy = value => JSON.parse(JSON.stringify(value));
const settled = row => ['answered', 'completed'].includes(row.status);
const states = new Set(['retained', 'submitted', 'deferred', 'running', 'answered', 'completed', 'unconfirmed']);

/** Owns pending independent inputs; conversation history and backend receipts stay separate. */
export function createAiuiInputLedger({ read, write }) {
  function load() {
    const value = read();
    if (value == null) return { seed: Date.now().toString(36) + Math.random().toString(36).slice(2, 10), counter: 0, rows: [] };
    if (typeof value.seed !== 'string' || !/^[a-z0-9]{1,24}$/.test(value.seed)
        || !Number.isSafeInteger(value.counter) || value.counter < 0 || value.counter >= Number.MAX_SAFE_INTEGER
        || !Array.isArray(value.rows) || value.rows.length > 64 || value.rows.some(row =>
          !row || typeof row.id !== 'string' || !/^[A-Za-z0-9:._-]{1,64}$/.test(row.id)
          || typeof row.scope !== 'string' || !row.scope.trim() || row.scope.length > 512
          || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 16000 || !states.has(row.status)
          || (row.answer !== undefined && (typeof row.answer !== 'string' || row.answer.length > 16000)))
        || new Set(value.rows.map(row => row.id)).size !== value.rows.length) {
      throw failure('AIUI_INPUT_STORAGE_INVALID');
    }
    return copy(value);
  }
  function save(value) {
    try {
      write(copy(value));
      if (JSON.stringify(read()) !== JSON.stringify(value)) throw Error('readback mismatch');
    } catch (cause) { throw Object.assign(failure('AIUI_INPUT_STORAGE_FAILED'), { cause }); }
  }
  function update(input, allowed, patch) {
    const state = load(), row = state.rows.find(item => item.id === input.id);
    if (!row || row.scope !== input.scope || row.text !== input.text || !allowed.includes(row.status)) throw failure('AIUI_INPUT_STATE_CONFLICT');
    Object.assign(row, patch); save(state); return copy(row);
  }
  return Object.freeze({
    snapshot() { return load().rows; },
    retain(text, scope, ticket = null) {
      if (typeof text !== 'string' || !text.trim() || text.length > 16000 || typeof scope !== 'string' || !scope.trim() || scope.length > 512) throw failure('AIUI_INPUT_INVALID');
      const state = load();
      while (state.rows.length >= 64) {
        const index = state.rows.findIndex(settled);
        if (index < 0) throw failure('AIUI_INPUT_STORAGE_FULL');
        state.rows.splice(index, 1);
      }
      const row = { id: 'voice-' + state.seed + '-' + (++state.counter), scope, text, ticket, status: 'retained' };
      state.rows.push(copy(row)); save(state);
      return Object.freeze({ id: row.id, scope, text });
    },
    submit(input) { return update(input, ['retained'], { status: 'submitted' }); },
    settle(input, result) {
      if (!result || result.input?.id !== input.id || result.input?.scope !== input.scope || result.input?.text !== input.text
          || result.toolDispatched !== false || !['answered','deferred','returned','unavailable','unconfirmed'].includes(result.status)
          || result.modelInvoked !== !['returned','unavailable'].includes(result.status)
          || (result.status === 'answered' && (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 16000))) throw failure('AIUI_INPUT_RECEIPT_INVALID');
      return update(input, ['submitted'], { status: ['returned','unavailable'].includes(result.status) ? 'retained' : result.status,
        ...(result.status === 'answered' ? { answer: result.text } : {}) });
    },
    beginRun(input) { return update(input, ['retained','deferred'], { status: 'running' }); },
    finishRun(input, result) {
      return update(input, ['running'], { status: result?.state === 'completed' ? 'completed' : 'unconfirmed',
        ...(typeof result?.text === 'string' ? { answer: result.text.slice(0, 16000) } : {}) });
    },
    recover() {
      const state = load(); let changed = false;
      for (const row of state.rows) if (['submitted','running'].includes(row.status)) { row.status = 'unconfirmed'; changed = true; }
      if (changed) save(state);
      return state.rows.filter(row => !settled(row));
    }
  });
}
