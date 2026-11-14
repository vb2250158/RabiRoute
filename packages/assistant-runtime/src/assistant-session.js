import { createAgentProtocol, snapshotTaskObservation } from './decision-protocol.js';
import { createAgentTurnRuntime } from './turn-runtime.js';
import { checkCurrent } from './assert-current.js';
import { unavailableInterjection } from './interjection.js';

const failure = code => Object.assign(new Error(code), { code });
let instanceSequence = 0;
function snapshotProfile(value) {
  if (!value || typeof value.systemPrompt !== 'string' || value.systemPrompt.length > 65536) throw failure('ASSISTANT_PROFILE_INVALID');
  const copy = JSON.parse(JSON.stringify(value));
  if (copy.modelOptions !== undefined && (!copy.modelOptions || typeof copy.modelOptions !== 'object' || Array.isArray(copy.modelOptions))) throw failure('ASSISTANT_PROFILE_INVALID');
  return copy;
}
function release(resource, method) {
  try { Promise.resolve(resource?.[method]?.()).catch(() => {}); } catch (_) { /* Cleanup cannot certify backend cancellation. */ }
}

/** Session owner for a host model and a discovered, target-bound tool adapter.
 * Tool adapters own durable work and receipts; dispose only releases this client. */
export function createAssistantSession({ profile, createModel, discoverTools, protocol = createAgentProtocol(),
  sessionId = 'assistant-' + (++instanceSequence), initializationTimeoutMs = 30000,
  limits = {}, onText = () => {}, onState = () => {} } = {}) {
  if (typeof createModel !== 'function' || typeof discoverTools !== 'function'
      || typeof protocol?.modelOptions !== 'function' || !/^[A-Za-z0-9:._-]{1,40}$/.test(sessionId)
      || !Number.isSafeInteger(initializationTimeoutMs) || initializationTimeoutMs <= 0 || initializationTimeoutMs > 2147483647) throw failure('ASSISTANT_DEPENDENCIES_REQUIRED');
  let currentProfile = snapshotProfile(profile), pendingProfile = null, refreshPending = false;
  let epoch = 0, turnSequence = 0, closed = false, prepared = null, preparing = null, active = null;
  function invalidate() {
    epoch++;
    preparing?.controller.abort();
    preparing = null;
    if (prepared) {
      prepared.controller.abort();
      release(prepared.model, 'destroy');
      release(prepared.backend, 'dispose');
      prepared = null;
    }
  }
  function applyPending() {
    if (active || closed || (!pendingProfile && !refreshPending)) return;
    invalidate();
    if (pendingProfile) currentProfile = pendingProfile;
    pendingProfile = null;
    refreshPending = false;
  }
  async function prepare(assertCurrent) {
    if (closed) throw failure('ASSISTANT_CLOSED');
    if (prepared) return prepared;
    if (preparing) return preparing.promise;
    const ownerEpoch = epoch, controller = new AbortController();
    const valid = () => !closed && epoch === ownerEpoch && !controller.signal.aborted;
    let backend = null, model = null, timer, rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = () => reject(failure('ASSISTANT_INITIALIZATION_CANCELLED')); });
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    const timedOut = new Promise((_, reject) => { timer = setTimeout(() => {
      reject(failure('ASSISTANT_INITIALIZATION_TIMEOUT'));
      controller.abort();
    }, initializationTimeoutMs); });
    const acquire = async (operation, method) => {
      const incoming = Promise.resolve().then(() => {
        if (!valid()) throw failure('ASSISTANT_INITIALIZATION_CANCELLED');
        return operation();
      }).then(resource => {
        if (!valid()) { release(resource, method); throw failure('ASSISTANT_INITIALIZATION_CANCELLED'); }
        return resource;
      });
      return Promise.race([incoming, aborted, timedOut]);
    };
    const owner = { controller, promise: null };
    const profileSnapshot = snapshotProfile(currentProfile);
    owner.promise = (async () => {
      try {
        backend = await acquire(() => discoverTools({ profile: snapshotProfile(profileSnapshot), signal: controller.signal }), 'dispose');
        if (!backend || !Array.isArray(backend.tools) || typeof backend.executeTool !== 'function'
            || typeof backend.toolPolicy?.classify !== 'function' || typeof backend.toolPolicy?.inspectOutcome !== 'function') throw failure('ASSISTANT_TOOL_ADAPTER_INVALID');
        const options = { ...(profileSnapshot.modelOptions || {}) };
        // One global prompt, before any optional conversation seed messages.
        options.initialPrompts = [
          { role: 'system', content: profileSnapshot.systemPrompt },
          ...(options.initialPrompts || [])
        ];
        const framing = protocol.modelOptions(options, JSON.parse(JSON.stringify(backend.tools)));
        model = await acquire(() => {
          checkCurrent(assertCurrent);
          return createModel(framing.options, { profile: snapshotProfile(profileSnapshot), signal: controller.signal });
        }, 'destroy');
        if (!model || (typeof model.prompt !== 'function' && typeof model.promptStreaming !== 'function')) throw failure('ASSISTANT_MODEL_INVALID');
        if (!valid()) throw failure('ASSISTANT_INITIALIZATION_CANCELLED');
        prepared = { model, backend, tools: framing.tools, controller };
        return prepared;
      } catch (error) {
        controller.abort();
        release(model, 'destroy');
        release(backend, 'dispose');
        throw error;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', rejectAbort);
        if (preparing === owner) preparing = null;
      }
    })();
    preparing = owner;
    return owner.promise;
  }
  return Object.freeze({
    supportsTurnGuard: true,
    supportsInterjectionReceipts: true,
    async ready() {
      applyPending();
      const session = await prepare();
      return { ready: true, toolCount: session.tools.length };
    },
    async run(input, runOptions = {}) {
      return runInput(input, runOptions, false);
    },
    async observe(observation, runOptions = {}) {
      return runInput(snapshotTaskObservation(observation), runOptions, true);
    },
    guide(text) {
      if (closed) throw failure('ASSISTANT_CLOSED');
      if (!active || active.cancelled || active.observation) return { accepted: false, reason: 'idle' };
      if (active.turn?.getState().acceptingGuidance === false) return { accepted: false, reason: 'finishing' };
      if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw failure('TURN_GUIDANCE_INVALID');
      if (active.guidance.length >= 16) return { accepted: false, reason: 'full' };
      active.guidance.push(text);
      active.turn?.notifyGuidance();
      return { accepted: true };
    },
    notifyGuidance() {
      return !closed && !active?.observation && Boolean(active?.turn?.notifyGuidance());
    },
    interject(input, options) {
      if (closed || !active?.turn || active.cancelled || active.observation) {
        return unavailableInterjection(input, options, 'ASSISTANT_INTERJECTION_UNAVAILABLE');
      }
      return active.turn.interject(input, options);
    },
    configure(nextProfile) {
      if (closed) throw failure('ASSISTANT_CLOSED');
      pendingProfile = snapshotProfile(nextProfile);
      const deferred = Boolean(active);
      applyPending();
      return { applied: !deferred, deferred };
    },
    refreshTools() {
      if (closed) throw failure('ASSISTANT_CLOSED');
      refreshPending = true;
      const deferred = Boolean(active);
      applyPending();
      return { applied: !deferred, deferred };
    },
    cancel() {
      if (active) { active.cancelled = true; active.turn?.cancel(); }
      invalidate();
    },
    dispose() {
      if (closed) return;
      closed = true;
      if (active) { active.cancelled = true; active.turn?.cancel(); }
      pendingProfile = null;
      invalidate();
    },
    getState() { return { closed, busy: Boolean(active), ready: Boolean(prepared), pendingConfiguration: Boolean(pendingProfile || refreshPending), turn: active?.turn?.getState() || null }; }
  });
  async function runInput(input, runOptions, observation) {
      if (closed) throw failure('ASSISTANT_CLOSED');
      if (active) throw failure('ASSISTANT_BUSY');
      if (!observation && (typeof input !== 'string' || !input.trim() || input.length > 16000)) throw failure('TURN_INPUT_INVALID');
      if (!runOptions || typeof runOptions !== 'object' || Array.isArray(runOptions)
          || ['takeGuidance', 'onText', 'onState', 'assertCurrent'].some(key => runOptions[key] !== undefined && typeof runOptions[key] !== 'function')
          || (runOptions.inputScope !== undefined && (typeof runOptions.inputScope !== 'string' || !runOptions.inputScope.trim() || runOptions.inputScope.length > 512))
          || (runOptions.limits !== undefined && (!runOptions.limits || typeof runOptions.limits !== 'object' || Array.isArray(runOptions.limits)))) throw failure('ASSISTANT_RUN_OPTIONS_INVALID');
      runOptions = { ...runOptions, limits: { ...runOptions.limits } };
      const assertCurrent = runOptions.assertCurrent;
      checkCurrent(assertCurrent);
      applyPending();
      const owner = { turn: null, guidance: [], cancelled: false, observation };
      const settle = result => owner.guidance.length
        ? { ...result, pendingGuidance: owner.guidance.splice(0) } : result;
      active = owner;
      try {
        const session = await prepare(assertCurrent);
        if (owner.cancelled || closed) return settle({ state: 'cancelled', text: '', toolResults: [] });
        checkCurrent(assertCurrent);
        owner.turn = createAgentTurnRuntime({ ...limits, ...runOptions.limits, model: session.model, protocol,
          assertCurrent, inputScope: observation ? undefined : runOptions.inputScope,
          tools: session.tools, toolPolicy: session.backend.toolPolicy,
          turnId: runOptions.turnId || sessionId + ':' + (++turnSequence),
          executeTool: event => session.backend.executeTool(event),
          // Drain one owner per boundary; never combine two full queues into an invalid batch.
          takeGuidance: () => observation ? [] : owner.guidance.length ? owner.guidance.splice(0) : (runOptions.takeGuidance?.() || []),
          onText: value => { if (!owner.cancelled && !closed) (runOptions.onText || onText)(value); },
          onState: value => { if (!owner.cancelled && !closed) (runOptions.onState || onState)(value); }
        });
        const result = await (observation ? owner.turn.observe(input) : owner.turn.run(input));
        // A terminal tool may finish before another decision boundary consumes guidance.
        // Return ownership to the caller; never reopen the view or replay the operation.
        return settle(result);
      } catch (error) {
        if (owner.cancelled || closed) return settle({ state: 'cancelled', text: '', toolResults: [] });
        invalidate();
        if (owner.guidance.length) {
          // Host errors may be frozen or non-Error values. Preserve the original
          // cause without mutating it, while returning the unconsumed queue.
          const recoverable = new Error(typeof error?.message === 'string' ? error.message : 'ASSISTANT_RUN_FAILED');
          recoverable.code = typeof error?.code === 'string' ? error.code : 'ASSISTANT_RUN_FAILED';
          recoverable.cause = error;
          recoverable.pendingGuidance = owner.guidance.splice(0);
          throw recoverable;
        }
        throw error;
      } finally {
        if (active === owner) active = null;
        applyPending();
      }
  }
}
