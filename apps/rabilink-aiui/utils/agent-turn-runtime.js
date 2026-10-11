import { agentInput, parseAgentDecision, canonicalAgentIntent } from './agent-decision-protocol.js';
const failure = code => Object.assign(new Error(code), { code });
let sequence = 0;
/** One application Agent turn, serial requests to the same Rokid session.
 * Observations use supported user messages, not an invented provider tool role.
 * Dispatched HTTP writes may finish after cancellation. Caller destroys a cancelled model. */
export function createAgentTurnRuntime({ model, executeTool, tools = [], turnId = 'loop-' + (++sequence),
  takeGuidance = () => [], onText = () => {}, onState = () => {}, requestTimeoutMs = 30000,
  turnTimeoutMs = 180000, maxToolCalls = 16, maxSteps = 32 } = {}) {
  if (!model || typeof executeTool !== 'function' || !/^[A-Za-z0-9:._-]{1,64}$/.test(turnId)) throw failure('TURN_DEPENDENCIES_REQUIRED');
  if (![requestTimeoutMs, turnTimeoutMs, maxToolCalls, maxSteps].every(value => Number.isSafeInteger(value) && value > 0)
      || requestTimeoutMs > 30000 || turnTimeoutMs > 600000 || maxToolCalls > 128 || maxSteps > 256) throw failure('TURN_LIMIT_INVALID');
  const allowed = new Set(tools.map(tool => typeof tool === 'string' ? tool : tool?.function?.name));
  let state = 'idle', started = false, cancelled = false, stream = null, reader = null;
  let text = '', calls = 0, steps = 0, uncertain = false, writesUncertain = false, rejectCancellation;
  const results = [], writes = new Map();
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject; }); cancellation.catch(() => {});
  function publish(next) { state = next; onState({ state, toolCount: calls, settledToolCount: results.length, steps }); }
  async function bounded(action, timeoutMs) {
    let timer;
    try { return await Promise.race([action, cancellation, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('TURN_TIMEOUT')), timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  function cancelStream() {
    const target = reader && typeof reader.cancel === 'function' ? reader : stream;
    try { Promise.resolve(target?.cancel?.()).catch(() => {}); } catch (_) { /* Best effort; caller destroys the session. */ }
  }
  function emit(delta) {
    if (!delta || cancelled) return;
    if (text.length + delta.length > 16000) throw failure('TURN_RESPONSE_LIMIT');
    text += delta; publish('responding'); onText({ delta, text });
  }
  function guidance() {
    const values = takeGuidance();
    if (!Array.isArray(values) || values.length > 16 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 16000)) throw failure('TURN_GUIDANCE_INVALID');
    if (values.length) text = '';
    return values;
  }
  async function request(input) {
    stream = null; reader = null; let raw = '', plain = false, decided = false;
    const chunk = piece => {
      if (typeof piece !== 'string') throw failure('TURN_CHUNK_INVALID');
      raw += piece; if (raw.length > 262144) throw failure('TURN_RESPONSE_LIMIT');
      if (!decided && raw.trim()) { decided = true; plain = !raw.trimStart().startsWith('{'); if (plain) emit(raw); }
      else if (plain) emit(piece);
    };
    if (typeof model.promptStreaming === 'function') {
      stream = await bounded(Promise.resolve(model.promptStreaming(input)), requestTimeoutMs);
      reader = stream && typeof stream.read === 'function' ? stream : stream?.getReader?.();
      if (!reader || typeof reader.read !== 'function') throw failure('TURN_STREAM_INVALID');
      while (!cancelled) {
        const value = await bounded(Promise.resolve(reader.read()), requestTimeoutMs);
        if (cancelled) return { raw: '', plain: false };
        if (!value || value.done) break;
        const piece = typeof value.value === 'string' ? value.value : value.value?.text;
        if (piece !== undefined) chunk(piece);
        else await bounded(new Promise(resolve => setTimeout(resolve, 40)), requestTimeoutMs);
      }
    } else if (typeof model.prompt === 'function') {
      const reply = await bounded(Promise.resolve(model.prompt(input)), requestTimeoutMs);
      if (!cancelled) chunk(reply);
    } else throw failure('TURN_MODEL_UNAVAILABLE');
    return { raw, plain };
  }
  async function execute(decision) {
    if (!allowed.has(decision.name)) throw failure('TURN_TOOL_NOT_AVAILABLE');
    const mutation = decision.name === 'rabi_api_call' && ((decision.arguments.mode==='websocket' && decision.arguments.messages?.length>0) || !['GET','HEAD','OPTIONS'].includes(String(decision.arguments.method || '').toUpperCase()));
    const fingerprint = canonicalAgentIntent([decision.name, decision.arguments]);
    if (mutation && writes.has(fingerprint)) return writes.get(fingerprint);
    if (mutation && writesUncertain) return { outcome: { result: { structuredContent: { ok: false, uncertain: true, code: 'WRITE_RECONCILIATION_REQUIRED' } } } };
    if (calls >= maxToolCalls) throw failure('TURN_TOOL_LIMIT');
    if (decision.name === 'close_app' && Object.keys(decision.arguments).length) throw failure('TURN_TOOL_INVALID');
    const event = { callId: turnId + ':call-' + (++calls), functionName: decision.name, arguments: decision.arguments, isComplete: true };
    publish('executing-tool'); let result;
    try { result = await executeTool(event); }
    catch (error) { result = { uncertain: true, code: typeof error?.code === 'string' ? error.code : 'TOOL_OUTCOME_UNCONFIRMED', callId: event.callId }; }
    if (cancelled) return { cancelled: true };
    if (!result || result.uncertain || result.cancelled || result.result?.structuredContent?.uncertain || result.duplicate && result.state !== 'completed') { uncertain = true; if (mutation) writesUncertain = true; }
    if (result?.result?.isError || result?.result?.structuredContent?.ok === false) uncertain = true;
    results.push(result);
    const observation = { callId: event.callId, name: event.functionName, outcome: result };
    if (mutation) writes.set(fingerprint, observation);
    return observation;
  }
  async function loop(input) {
    let next = { kind: 'user-input', text: input };
    while (!cancelled) {
      if (steps >= maxSteps) throw failure('TURN_STEP_LIMIT');
      const earlyGuidance = guidance(); if (earlyGuidance.length) next = { ...next, steering: earlyGuidance };
      const requestId = turnId + ':step-' + (++steps); publish('thinking');
      const reply = await request(agentInput(requestId, next)); if (cancelled) return;
      const lateGuidance = guidance();
      if (lateGuidance.length) { next = { kind: 'steering', text: lateGuidance, superseded: requestId, actionExecuted: false }; continue; }
      const decision = parseAgentDecision(reply.raw, requestId);
      if (decision.kind === 'final') { if (!reply.plain) emit(decision.text); return; }
      if (decision.say) emit((text ? '\n' : '') + decision.say + '\n');
      const observation = await execute(decision); if (cancelled) return;
      if (observation.outcome?.terminal === true) return;
      next = { kind: 'tool-observation', untrusted: true, observation };
    }
  }
  return Object.freeze({
    async run(input) {
      if (started || cancelled) throw failure('TURN_ALREADY_STARTED');
      if (typeof input !== 'string' || !input.trim() || input.length > 16000) throw failure('TURN_INPUT_INVALID');
      started = true;
      try {
        await bounded(loop(input), turnTimeoutMs);
        if (cancelled) return { state: 'cancelled', text: '', toolResults: [] };
        publish(uncertain ? 'uncertain' : 'completed'); return { state, text, toolResults: results, steps };
      } catch (error) {
        if (cancelled) return { state: 'cancelled', text: '', toolResults: [] };
        cancelled = true; rejectCancellation(failure('TURN_CANCELLED')); cancelStream(); publish('failed'); throw error;
      }
    },
    cancel() {
      if (cancelled || ['completed','uncertain','failed'].includes(state)) return;
      cancelled = true; rejectCancellation(failure('TURN_CANCELLED')); cancelStream(); publish('cancelled');
    },
    getState() { return { state, toolCount: calls, settledToolCount: results.length, steps }; }
  });
}
