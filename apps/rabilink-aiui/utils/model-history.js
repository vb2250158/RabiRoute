// Native model transcript journal. Storage is supplied by the AIUI host.
// Completed prompt exchanges seed context; incomplete requests never replay.
import { canonicalAgentIntent } from '../../../packages/assistant-runtime/src/decision-protocol.js';
const copy = value => JSON.parse(JSON.stringify(value));
const fail = code => Object.assign(new Error(code), { code });
const partSize = 16;

export function createModelHistory({ read, write, scope, contextChars = 32768 }) {
  if (typeof read !== 'function' || typeof write !== 'function' || !/^[a-f0-9]{64}$/.test(scope))
    throw fail('AIUI_MODEL_HISTORY_INVALID');
  const prefix = 'rabilink-model-history-v1:' + scope;
  const indexKey = prefix + ':index';
  const partKey = sequence => prefix + ':' + Math.floor((sequence - 1) / partSize);
  function index() {
    const value = read(indexKey);
    if (value === undefined) return { version: 1, count: 0, revision: 0 };
    if (value?.version !== 1 || !Number.isSafeInteger(value.count) || value.count < 0
      || !Number.isSafeInteger(value.revision) || value.revision < value.count) throw fail('AIUI_MODEL_HISTORY_INVALID');
    return copy(value);
  }
  function save(key, value) {
    try {
      write(key, copy(value));
      if (canonicalAgentIntent(read(key)) !== canonicalAgentIntent(value)) throw Error('readback');
    } catch (_) { throw fail('AIUI_MODEL_HISTORY_STORAGE_FAILED'); }
  }
  function rowsFor(sequence) {
    const rows = read(partKey(sequence));
    if (rows === undefined) return [];
    if (!Array.isArray(rows) || rows.length > partSize || rows.some(row => !row
      || !Number.isSafeInteger(row.sequence) || !Array.isArray(row.input)
      || !['pending', 'completed', 'failed'].includes(row.state))) throw fail('AIUI_MODEL_HISTORY_INVALID');
    return copy(rows);
  }
  function begin(input) {
    const state = index(), sequence = state.count + 1;
    if (!Number.isSafeInteger(sequence)) throw fail('AIUI_MODEL_HISTORY_FULL');
    const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : copy(input);
    if (!Array.isArray(messages) || messages.some(message => !['user', 'assistant'].includes(message?.role)
      || typeof message.content !== 'string')) throw fail('AIUI_MODEL_HISTORY_INPUT_INVALID');
    // A crash before publishing the index leaves one unreachable slot. Reusing
    // that exact slot is safe because no model request was dispatched yet.
    const rows = rowsFor(sequence).filter(row => row.sequence < sequence);
    rows.push({ sequence, input: messages, state: 'pending', activityAt: Date.now() });
    save(partKey(sequence), rows);
    save(indexKey, { ...state, count: sequence, revision: state.revision + 1 });
    return { sequence, revision: state.revision + 1 };
  }
  function settle(ticket, state, text = '') {
    const current = index();
    if (current.count !== ticket.sequence || current.revision !== ticket.revision)
      throw fail('AIUI_MODEL_HISTORY_OWNER_CHANGED');
    const rows = rowsFor(ticket.sequence), row = rows.find(item => item.sequence === ticket.sequence);
    if (!row || row.state !== 'pending') throw fail('AIUI_MODEL_HISTORY_OWNER_CHANGED');
    Object.assign(row, { state, text, activityAt: Date.now() });
    save(partKey(ticket.sequence), rows);
    save(indexKey, { ...current, revision: current.revision + 1 });
  }
  function recent(limit = 32) {
    const state = index(), result = [];
    for (let sequence = state.count; sequence > 0 && result.length < limit;) {
      const rows = rowsFor(sequence).filter(row => row.sequence <= state.count);
      if (!rows.some(row => row.sequence === sequence)) throw fail('AIUI_MODEL_HISTORY_INVALID');
      result.unshift(...rows);
      sequence = Math.floor((sequence - 1) / partSize) * partSize;
    }
    return result.slice(-limit);
  }
  function seed() {
    const exchanges = [], rows = recent(128); let used = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.state !== 'completed') continue;
      const size = JSON.stringify(row.input).length + row.text.length;
      if (used + size > contextChars) break;
      used += size;
      exchanges.unshift(...row.input, { role: 'assistant', content: row.text });
    }
    return exchanges;
  }
  async function createModel(factory, options) {
    const model = await factory({ ...options, initialPrompts: [...(options.initialPrompts || []), ...seed()] });
    let closed = false, active = null;
    const start = input => {
      if (closed || active) throw fail('AIUI_MODEL_HISTORY_BUSY');
      return active = begin(input);
    };
    const finish = (ticket, state, text) => {
      if (active !== ticket) return;
      try { settle(ticket, state, text); } finally { active = null; }
    };
    const wrapper = {
      async prompt(input) {
        const ticket = start(input);
        try { const text = await model.prompt(input); finish(ticket, 'completed', text); return text; }
        catch (error) { finish(ticket, 'failed'); throw error; }
      },
      promptStreaming(input) {
        const ticket = start(input); let stream, text = '';
        try { stream = model.promptStreaming(input); }
        catch (error) { finish(ticket, 'failed'); throw error; }
        return {
          async read() {
            try {
              const chunk = await stream.read();
              if (closed || active !== ticket) throw fail('AIUI_MODEL_HISTORY_CLOSED');
              if (typeof chunk.value === 'string') text += chunk.value;
              if (chunk.done) finish(ticket, 'completed', text);
              return chunk;
            } catch (error) { finish(ticket, 'failed'); throw error; }
          },
          cancel() { try { stream.cancel(); } finally { finish(ticket, 'failed'); } }
        };
      },
      // Interjection clones have independent native histories and never write
      // the original model's journal or execute a second tool chain.
      ...(typeof model.clone === 'function' ? { clone: () => model.clone() } : {}),
      addEventListener: (...args) => model.addEventListener?.(...args),
      removeEventListener: (...args) => model.removeEventListener?.(...args),
      destroy() {
        if (closed) return;
        closed = true;
        try { if (active) finish(active, 'failed'); } finally { model.destroy?.(); }
      }
    };
    if (typeof model.promptStreaming !== 'function') delete wrapper.promptStreaming;
    if (typeof model.prompt !== 'function') delete wrapper.prompt;
    return wrapper;
  }
  return Object.freeze({ createModel, seed, recent });
}
