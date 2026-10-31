import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { clone, describeService, serviceProxy, validEnvelope, envelope, errorData, remoteError, TransportError } from './protocol.mjs';

let binding, lastSequence = 0, sequence = 0, state = 'new', contracts;
const abort = new AbortController(), providers = new Map(), contributions = [], starters = [], disposers = [], pending = new Map();
const activeTasks = new Set();
let disposal;
function send(body, requestId, seq) {
  if (!process.connected) return;
  try { process.send(envelope(binding.nonce, binding.identity, requestId, seq, body), () => {}); }
  catch { /* Disconnect cleanup/parent actual-close observation owns this peer. */ }
}
function callHost(capability, method, args) {
  if (abort.signal.aborted) return Promise.reject(new TransportError('OWNER_REVOKED', 'Plugin owner is revoked.'));
  if (pending.size >= 64) return Promise.reject(new TransportError('RPC_CAPACITY', 'Plugin has 64 in-flight host calls.'));
  const requestId = randomUUID(), seq = ++sequence;
  return new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject, sequence: seq }); send({ type: 'host-call', capability, method, args }, requestId, seq); });
}
function contextFor(payload) {
  contracts = payload.contracts;
  const unsupported = new Set(payload.services.filter(item => item.kind === 'unsupported').map(item => item.capability));
  const services = new Map(payload.services.map(item => [item.capability, unsupported.has(item.capability) ? undefined : serviceProxy(item, callHost)]));
  const assertTransport = capability => { if (unsupported.has(capability)) throw new TransportError('UNSUPPORTED_SERVICE_TRANSPORT', 'Capability requires its original native owner: ' + capability, { capability }); };
  const requireActive = () => { if (abort.signal.aborted) throw new TransportError('OWNER_REVOKED', 'Plugin owner is revoked.'); };
  return Object.freeze({
    identity: Object.freeze(clone(binding.identity, 'identity')), config: clone(payload.config, 'config'),
    services: Object.freeze({
      require(capability) { requireActive(); assertTransport(capability); if (!services.has(capability)) throw new TransportError('CAPABILITY_MISSING', `Missing ${capability}.`); return services.get(capability); },
      optional(capability) { requireActive(); assertTransport(capability); return services.get(capability); },
      provide(capability, value) { requireActive(); if (!payload.provides.includes(capability) || providers.has(capability)) throw new TransportError('INVALID_PROVIDE', `Unexpected/duplicate provider ${capability}.`); const descriptor = describeService(capability, value, contracts); providers.set(capability, { value, descriptor }); }
    }),
    contributions: Object.freeze({ register(value) { requireActive(); if (typeof value?.kind !== 'string' || typeof value?.id !== 'string') throw new TransportError('INVALID_CONTRIBUTION', 'Contribution kind/id required.'); contributions.push(clone(value, 'contribution')); } }),
    permissions: Object.freeze({ list: () => [...payload.permissions], has: value => payload.permissions.includes(value), require(value) { if (!payload.permissions.includes(value)) throw new TransportError('PERMISSION_MISSING', `Missing configured permission ${value}.`); } }),
    lifecycle: Object.freeze({ signal: abort.signal, fail(error) { send({ type: 'failure', error: errorData(error) }, randomUUID(), ++sequence); void dispose().finally(() => process.exit(1)); } }),
    publication: Object.freeze({ add() { throw new TransportError('UNSUPPORTED_SYNCHRONOUS_PUBLICATION', 'Synchronous Manager pointer publication cannot be performed over asynchronous IPC.'); } }),
    effects: Object.freeze({ add(starter) { requireActive(); if (state !== 'new') throw new TransportError('EFFECTS_SEALED', 'Activation effects are sealed.'); starters.push(starter); }, adopt(disposer) { requireActive(); disposers.push(disposer); } })
  });
}
function dispose() {
  if (disposal) return disposal;
  abort.abort(new TransportError('OWNER_REVOKED', 'Plugin owner revoked.'));
  disposal = (async () => {
    // An abort is not a join. Late activation/effect/provider work remains owned
    // until it actually settles, or the parent proves this process has closed.
    await Promise.allSettled([...activeTasks]);
    const failures = [];
    for (const release of [...disposers].reverse()) { try { await release(); } catch (error) { failures.push(error); } }
    state = 'disposed';
    if (failures.length) throw new AggregateError(failures, 'Plugin cleanup failed.');
  })();
  return disposal;
}
async function command(message) {
  if (message.command === 'ping') return { state };
  if (message.command === 'prepare') {
    if (state !== 'new') throw new TransportError('INVALID_STATE', 'Prepare cannot be replayed.');
    const context = contextFor(message.payload);
    const module = await import(pathToFileURL(message.payload.entryPath).href);
    if (typeof module.activate !== 'function') throw new TransportError('INVALID_ENTRY', 'Entry must export activate(context).');
    await module.activate(context);
    state = 'prepared';
    return { services: [...providers.values()].map(item => item.descriptor), contributions };
  }
  if (message.command === 'commit') {
    if (state !== 'prepared') throw new TransportError('INVALID_STATE', 'Commit cannot be replayed.');
    state = 'committing';
    for (const start of starters) { abort.signal.throwIfAborted(); const release = await start(); if (typeof release === 'function') disposers.push(release); abort.signal.throwIfAborted(); }
    state = 'committed'; return {};
  }
  if (message.command === 'invoke') {
    if (state !== 'committed') throw new TransportError('INVALID_STATE', 'Provider is not committed.');
    const item = providers.get(message.payload.capability);
    if (item?.descriptor.kind !== 'async-methods' || !item.descriptor.methods.includes(message.payload.method)) throw new TransportError('UNSUPPORTED_SERVICE_TRANSPORT', 'Provider method has no async transport declaration.');
    return clone(await Reflect.apply(item.value[message.payload.method], item.value, message.payload.args), 'provider result');
  }
  if (message.command === 'dispose') { await dispose(); return {}; }
  throw new TransportError('INVALID_COMMAND', 'Unknown isolated command.');
}
process.on('message', message => {
  if (!binding) {
    if (message?.type !== 'bind' || typeof message.nonce !== 'string' || !message.identity) return;
    binding = { nonce: message.nonce, identity: message.identity }; return;
  }
  if (!validEnvelope(message, binding.nonce, binding.identity)) return;
  if (message.type === 'host-result') {
    const item = pending.get(message.requestId);
    if (!item || item.sequence !== message.sequence) return;
    pending.delete(message.requestId);
    send({ type: 'host-result-ack' }, message.requestId, message.sequence);
    message.error ? item.reject(remoteError(message.error)) : item.resolve(message.value); return;
  }
  if (message.type !== 'command' || message.sequence <= lastSequence) return;
  lastSequence = message.sequence;
  const task = command(message);
  if (message.command !== 'dispose') activeTasks.add(task);
  void task.then(value => send({ type: 'result', value }, message.requestId, message.sequence), error => send({ type: 'result', error: errorData(error) }, message.requestId, message.sequence)).finally(() => activeTasks.delete(task));
});
process.once('disconnect', () => { void dispose().finally(() => process.exit(1)); });
