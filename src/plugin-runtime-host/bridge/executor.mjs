import { fork } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { clone, describeService, serviceProxy, contractFor, validEnvelope, envelope, remoteError, errorData, ownerOutcome, ownData, identityTuple, TransportError } from './protocol.mjs';

const childEntry = fileURLToPath(new URL('./child.mjs', import.meta.url));
function timeout(promise, milliseconds, code, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new TransportError(code, message)), milliseconds); })]).finally(() => clearTimeout(timer));
}
export async function verifyImmutableEntry(candidate, proof) {
  const root = await fs.realpath(proof.root), entry = await fs.realpath(candidate.entry.path);
  const relative = path.relative(root, entry);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new TransportError('INVALID_PACKAGE_ROOT', 'Entry is outside its catalog-owned package root.');
  const row = proof.files.find(item => item.relative.split('/').join(path.sep) === relative);
  if (!row || row.sha256 !== createHash('sha256').update(await fs.readFile(entry)).digest('hex')) throw new TransportError('PACKAGE_CHANGED', 'Immutable package entry no longer matches its original catalog proof.');
  return { entryPath: entry, root };
}

class RuntimeOwner {
  constructor({ identity, context, candidate, contracts, runWithIdentity, requestMs, shutdownMs, launch, terminate, joinTermination, record, reserveCall, classifyEffect, archiveUnknown, joinArchives }) {
    Object.assign(this, { identity, context, candidate, contracts, runWithIdentity, requestMs, shutdownMs, launch, terminate, joinTermination, record, reserveCall, classifyEffect, archiveUnknown, joinArchives });
    this.nonce = randomUUID(); this.sequence = 0; this.incomingSequence = 0; this.pending = new Map(); this.hostCalls = new Map(); this.provided = new Set();
    this.effectOverrides = new Set();
    this.state = 'created'; this.firstFailure = undefined; this.stopping = undefined; this.observation = { exit: null, close: null };
  }
  evidence() {
    return { identity: clone(this.identity, 'identity'), state: this.state, pid: this.child?.pid ?? null, firstFailure: this.firstFailure && errorData(this.firstFailure), firstUnknownObservation: this.firstUnknownObservation, observation: clone(this.observation, 'observation'), calls: [...this.hostCalls.values()].map(({ promise, releaseAdmission, archivePromise, ...item }) => ({ ...item })), pending: [...this.pending.keys()] };
  }
  recordEvidence() { try { Promise.resolve(this.record(this.evidence())).catch(error => { this.firstFailure ??= error; }); } catch (error) { this.firstFailure ??= error; } }
  fail(error) { this.firstFailure ??= error; this.recordEvidence(); }
  notifyFailure(error) {
    if (this.failureNotified) return;
    this.failureNotified = true;
    try { Promise.resolve(this.context.lifecycle.fail(error)).catch(cause => this.fail(cause)); }
    catch (cause) { this.fail(cause); }
  }
  acknowledged(receipt) { return receipt.responseDelivery === 'received_by_child' || receipt.effectOutcome === 'read_only' && receipt.failureNoticeDelivery === 'received_by_child'; }
  releaseKnownAdmission(receipt) { if (receipt.settled && receipt.effectOutcome !== 'unknown' && (!receipt.dispatchStarted || this.acknowledged(receipt) || this.observation.close)) receipt.releaseAdmission?.(); }
  methodEffect(capability, method, declared) {
    const local = this.effectOverrides.has(JSON.stringify([capability, method])) ? 'unknown' : declared;
    return this.classifyEffect?.(this.identity, capability, method, local) ?? local;
  }
  readOnly(receipt) { return receipt.methodEffect === 'read' && receipt.nativeOutcome?.mutationOutcome !== 'unknown'; }
  observeNativeEffect(receipt) {
    if (receipt.methodEffect === 'read' && receipt.nativeOutcome?.mutationOutcome === 'unknown') this.effectOverrides.add(JSON.stringify([receipt.capability, receipt.method]));
  }
  start() {
    this.child = this.launch(childEntry, this.identity, this.candidate);
    this.actualClose = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.observation.close = { code, signal, observedAt: Date.now() }; this.state = 'closed';
      if (!this.stopping) {
        const error = new TransportError('PLUGIN_CLOSED', 'Isolated plugin process closed.');
        this.fail(error); this.notifyFailure(error);
      }
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.firstFailure ?? new TransportError('OWNER_REVOKED', 'Original plugin process closed.')); }
      this.pending.clear(); resolve(this.observation.close);
      this.context.lifecycle.signal?.removeEventListener('abort', this.onAbort);
      for (const receipt of this.hostCalls.values()) {
        if (!['received_by_child', 'unavailable'].includes(receipt.responseDelivery)) this.responseUnavailable(receipt, 'original child closed');
        this.releaseKnownAdmission(receipt);
      }
      this.maybeFinalize();
    }));
    this.child.once('exit', (code, signal) => { this.observation.exit = { code, signal, observedAt: Date.now() }; this.recordEvidence(); });
    this.child.on('error', error => { this.fail(error); });
    this.child.on('message', message => this.receive(message));
    this.onAbort = () => { this.fail(this.context.lifecycle.signal.reason instanceof Error ? this.context.lifecycle.signal.reason : new TransportError('OWNER_REVOKED', 'Original activation was aborted.')); void this.stop().catch(error => this.fail(error)); };
    this.context.lifecycle.signal?.addEventListener('abort', this.onAbort, { once: true });
    this.child.send({ type: 'bind', nonce: this.nonce, identity: this.identity });
    this.state = 'preparing';
  }
  request(command, payload, milliseconds = this.requestMs, duringStop = false) {
    if (!this.child?.connected || this.observation.close || (this.stopping && !duringStop)) return Promise.reject(new TransportError('OWNER_REVOKED', 'Isolated owner is unavailable.'));
    if (this.pending.size >= 64) return Promise.reject(new TransportError('RPC_CAPACITY', 'Isolated owner has 64 in-flight requests.'));
    const requestId = randomUUID(), sequence = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new TransportError('PLUGIN_OPERATION_UNCONFIRMED', `Isolated ${command} exceeded its deadline; the original operation will not be replayed.`, { requestId, command });
        this.fail(error);
        if (this.state === 'committed') this.notifyFailure(error);
        // Keep the original request until true process close; no replacement ID
        // is issued. The caller sees a timeout; teardown still owns its outcome.
        reject(error);
        void this.stop().catch(stopError => this.fail(stopError));
      }, milliseconds);
      this.pending.set(requestId, { resolve, reject, timer, sequence, command });
      this.child.send(envelope(this.nonce, this.identity, requestId, sequence, { type: 'command', command, payload }), error => {
        if (!error) return;
        const item = this.pending.get(requestId);
        if (!item) return;
        clearTimeout(item.timer); this.pending.delete(requestId); item.reject(error); this.fail(error); void this.stop().catch(stopError => this.fail(stopError));
      });
    });
  }
  receive(message) {
    if (!validEnvelope(message, this.nonce, this.identity)) return;
    if (message.type === 'host-result-ack') {
      const receipt = this.hostCalls.get(message.requestId);
      if (!receipt || receipt.sequence !== message.sequence) return;
      if (receipt.responseDelivery === 'unavailable') receipt.failureNoticeDelivery = 'received_by_child';
      else receipt.responseDelivery = 'received_by_child';
      this.releaseKnownAdmission(receipt);
      this.publishReceipt(receipt); return;
    }
    if (message.type === 'result') {
      const item = this.pending.get(message.requestId);
      if (!item || item.sequence !== message.sequence) return;
      clearTimeout(item.timer); this.pending.delete(message.requestId);
      message.error ? item.reject(remoteError(message.error)) : item.resolve(message.value); return;
    }
    if (message.sequence <= this.incomingSequence) return;
    this.incomingSequence = message.sequence;
    if (message.type === 'failure') {
      const error = remoteError(message.error); this.fail(error); this.notifyFailure(error); void this.stop().catch(stopError => this.fail(stopError)); return;
    }
    if (message.type !== 'host-call' || this.stopping || this.hostCalls.has(message.requestId)) return;
    // Terminal diagnostic history is bounded; accepted/unknown operations are
    // never evicted or retried. At most 64 such operations may be admitted.
    const running = [...this.hostCalls.values()].filter(item => !item.settled);
    let declaredRead = false;
    try { const contract = contractFor(this.contracts, message.capability); declaredRead = contract.kind === 'async-methods' && contract.methods.includes(message.method) && this.methodEffect(message.capability, message.method, contract.effects?.[message.method] ?? 'unknown') === 'read'; } catch { /* The ordinary pre-dispatch validation below reports the contract failure. */ }
    const unknown = [...this.hostCalls.values()].filter(item => item.settled && item.effectOutcome === 'unknown');
    if (running.length >= 64 || !declaredRead && unknown.length >= 64) { this.replyHost(message, { error: errorData(new TransportError('RPC_CAPACITY', 'This original owner has no free call slot.')) }); return; }
    const terminal = [...this.hostCalls.values()].filter(item => item.settled && item.effectOutcome !== 'unknown' && (this.acknowledged(item) || !item.dispatchStarted));
    while (terminal.length >= 64) this.hostCalls.delete(terminal.shift().requestId);
    const receipt = { requestId: message.requestId, sequence: message.sequence, capability: message.capability, method: message.method, status: 'received', startedAt: Date.now(), dispatchStarted: false, settled: false, executionOutcome: 'not_started', effectOutcome: 'not_started', responseDelivery: 'pending', retryAllowed: false, uncertaintyObserved: false };
    this.hostCalls.set(message.requestId, receipt);
    receipt.promise = (async () => {
      try {
        const contract = contractFor(this.contracts, message.capability);
        if (contract.kind !== 'async-methods' || !contract.methods.includes(message.method) || !this.allowedServices.has(message.capability)) throw new TransportError('UNSUPPORTED_SERVICE_TRANSPORT', 'Host method has no matching async transport declaration.');
        const value = this.hostValues.get(message.capability);
        const args = clone(message.args, 'host arguments');
        const method = ownData(value, message.method);
        if (typeof method !== 'function') throw new TransportError('UNSUPPORTED_SERVICE_TRANSPORT', 'Original host method is no longer available.');
        receipt.methodEffect = this.methodEffect(message.capability, message.method, contract.effects?.[message.method] ?? 'unknown');
        receipt.releaseAdmission = this.reserveCall?.(this.identity, message.requestId, receipt.methodEffect) ?? (() => {});
        receipt.status = 'accepted';
        const valueReturned = await this.runWithIdentity(this.identity, () => { receipt.dispatchStarted = true; receipt.executionOutcome = 'running'; receipt.effectOutcome = this.readOnly(receipt) ? 'read_only' : 'unknown'; return Reflect.apply(method, value, args); });
        receipt.executionOutcome = 'completed'; receipt.status = 'completed';
        receipt.nativeOutcome = { ...ownerOutcome(ownData(valueReturned, 'body')), ...ownerOutcome(valueReturned) };
        this.observeNativeEffect(receipt);
        receipt.effectOutcome = this.readOnly(receipt) ? 'read_only' : receipt.nativeOutcome.mutationOutcome === 'unknown' || receipt.nativeOutcome.uncertain === true ? 'unknown' : 'returned';
        let result;
        try { result = clone(valueReturned, 'host result'); }
        catch (error) {
          receipt.effectOutcome = this.readOnly(receipt) ? 'read_only' : 'unknown'; receipt.responseDelivery = 'unavailable'; receipt.status = 'response_unavailable';
          throw Object.assign(new TransportError('HOST_RESPONSE_UNAVAILABLE', 'Original host execution completed but its response cannot be transported.', { requestId: receipt.requestId, nativeOutcome: receipt.nativeOutcome }), receipt.nativeOutcome, { effectOutcome: receipt.effectOutcome, ...(!Object.hasOwn(receipt.nativeOutcome, 'uncertain') ? { uncertain: true } : {}), retryAllowed: false });
        }
        this.replyHost(message, { value: result }, receipt);
      } catch (error) {
        if (receipt.executionOutcome !== 'completed') receipt.executionOutcome = receipt.dispatchStarted ? 'threw' : 'not_started';
        receipt.status = receipt.executionOutcome === 'completed' ? 'response_unavailable' : receipt.dispatchStarted ? 'failed_after_dispatch' : 'rejected_before_dispatch';
        receipt.nativeOutcome ??= ownerOutcome(error);
        this.observeNativeEffect(receipt);
        receipt.effectOutcome = receipt.dispatchStarted ? this.readOnly(receipt) ? 'read_only' : 'unknown' : 'not_started';
        receipt.error = { ...errorData(error), ...(!receipt.dispatchStarted ? { mutationOutcome: 'not_started' } : ownData(error, 'uncertain') === undefined ? { uncertain: true } : {}), effectOutcome: receipt.effectOutcome, dispatchStarted: receipt.dispatchStarted, retryAllowed: false };
        this.replyHost(message, { error: receipt.error }, receipt);
      }
      finally { receipt.settled = true; receipt.completedAt = Date.now(); this.publishReceipt(receipt); this.releaseKnownAdmission(receipt); this.maybeFinalize(); this.recordEvidence(); }
    })();
    this.recordEvidence();
  }
  publishReceipt(receipt) {
    if (receipt.effectOutcome !== 'unknown') return;
    receipt.uncertaintyObserved = true;
    this.firstUnknownObservation ??= { observedAt: Date.now(), requestId: receipt.requestId, executionOutcome: receipt.executionOutcome, responseDelivery: receipt.responseDelivery };
    const { promise, releaseAdmission, archivePromise, ...snapshot } = receipt;
    const archived = this.onUnknown?.(clone(snapshot, 'original uncertain receipt'));
    if (this.archiveUnknown) {
      receipt.archiveConfirmed = false;
      const original = Promise.resolve(archived); receipt.archivePromise = original;
      void original.then(() => { if (receipt.archivePromise === original) { receipt.archiveConfirmed = true; delete receipt.archiveFailure; if (receipt.settled) receipt.releaseAdmission?.(); this.maybeFinalize(); } }, error => { if (receipt.archivePromise === original) { receipt.archiveFailure = errorData(error); this.recordEvidence(); } });
    }
  }
  responseUnavailable(receipt, reason) {
    receipt.responseDelivery = 'unavailable'; receipt.responseFailure = reason;
    if (receipt.dispatchStarted) receipt.effectOutcome = this.readOnly(receipt) ? 'read_only' : 'unknown';
    this.publishReceipt(receipt);
  }
  replyHost(message, result, receipt) {
    if (!this.child.connected || this.observation.close) { if (receipt) this.responseUnavailable(receipt, 'original child unavailable'); return; }
    try {
      this.child.send(envelope(this.nonce, this.identity, message.requestId, message.sequence, { type: 'host-result', ...result }), error => {
        if (error) { if (receipt) this.responseUnavailable(receipt, 'IPC response send failed'); this.fail(error); }
        else if (receipt?.responseDelivery === 'unavailable') receipt.failureNoticeDelivery ??= 'queued';
        else if (receipt && receipt.responseDelivery === 'pending') receipt.responseDelivery = 'queued';
      });
    } catch (error) { if (receipt) this.responseUnavailable(receipt, 'IPC response send threw'); this.fail(error); }
  }
  maybeFinalize() {
    if (this.joined || !this.observation.close || [...this.hostCalls.values()].some(item => !item.settled || this.archiveUnknown && item.uncertaintyObserved && !item.archiveConfirmed)) return;
    this.joined = true; this.state = 'retired'; this.onJoined?.();
  }
  stop() {
    // Fence synchronously before any await; no callbacks can enter a revoked
    // owner. Promise scheduling permits assigning stopping before request().
    if (!this.stopping) { this.state = 'revoked'; this.stopping = Promise.resolve().then(async () => {
      if (!this.child) return;
      if (!this.observation.close && this.child.connected) await this.request('dispose', undefined, this.shutdownMs, true).catch(error => this.fail(error));
      if (!this.observation.close) await this.terminate(this.child);
      await timeout(this.actualClose, this.shutdownMs, 'PLUGIN_CLOSE_UNCONFIRMED', 'Termination was requested but the original child has not emitted close.');
    }); }
    return (this.observation.close ? Promise.resolve() : this.stopping).then(async () => {
      const unknown = [...this.hostCalls.values()].filter(item => !item.settled);
      if (unknown.length) throw new TransportError('HOST_CALLS_UNSETTLED', 'Child closed, but accepted host operations have not settled. Original receipts are retained; no replay.', { requestIds: unknown.map(item => item.requestId) });
      if (this.joinArchives) { await this.joinArchives(this.identity); for (const receipt of this.hostCalls.values()) if (receipt.uncertaintyObserved) { receipt.archiveConfirmed = true; delete receipt.archiveFailure; receipt.releaseAdmission?.(); } }
      this.maybeFinalize();
    });
  }
  retire() {
    if (this.retirement) return this.retirement;
    // The SDK owns this actual join, independently of the bounded stop
    // observation. Its budget may report pending, but a later real settlement
    // must complete the same original resource Promise, not a replacement call.
    void this.stop().catch(() => {});
    this.retirement = (async () => {
      if (this.child) await this.actualClose;
      if (this.child && this.joinTermination) await this.joinTermination(this.child);
      await Promise.allSettled([...this.hostCalls.values()].map(receipt => receipt.promise));
      if (this.joinArchives) await this.joinArchives(this.identity);
      for (const receipt of this.hostCalls.values()) if (receipt.uncertaintyObserved) { receipt.archiveConfirmed = true; receipt.releaseAdmission?.(); }
      this.maybeFinalize();
    })();
    return this.retirement;
  }
}

// This implements the kernel's prepare()->activate(context) interface. It is a
// private prototype: the producer must supply a catalog-owned immutable proof,
// and host adapters must explicitly declare asynchronous transport semantics.
export class BridgedIsolatedPluginExecutor {
  constructor({ contracts = {}, resolvePackage, runWithIdentity, launch, terminate, joinTermination, requestMs = 1000, shutdownMs = 500, record = () => {}, reserveCall, classifyEffect, archiveUnknown, joinArchives } = {}) {
    if (typeof resolvePackage !== 'function' || typeof runWithIdentity !== 'function') throw new Error('Catalog proof resolver and original activation-context runner are required.');
    this.options = { contracts, resolvePackage, runWithIdentity, requestMs, shutdownMs, record, reserveCall, classifyEffect, archiveUnknown, joinArchives, joinTermination,
      launch: launch ?? (entry => fork(entry, [], { windowsHide: true, serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [], env: {} })),
      terminate: terminate ?? (async child => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }) };
    this.owners = new Map();
    this.recentlyClosed = new Map();
    this.uncertainReceipts = new Map();
  }
  async prepare(candidate, identity) {
    if (candidate.entry.execution !== 'isolated') throw new TransportError('INVALID_MODE', 'Explicit isolated execution mode required.');
    const root = await this.options.resolvePackage(candidate);
    const resolved = await verifyImmutableEntry(candidate, root);
    const key = JSON.stringify(identity);
    if (this.owners.has(key) || this.recentlyClosed.has(key)) throw new TransportError('OWNER_EXISTS', 'Original activation already owns an execution record.');
    let activated = false;
    return Object.freeze({ activate: async context => {
      if (activated) throw new TransportError('ACTIVATION_REPLAY_FORBIDDEN', 'Activation may execute only once.');
      activated = true;
      if (!isDeepStrictEqual(context.identity, identity)) throw new TransportError('OWNER_MISMATCH', 'Activation identity changed.');
      if (this.owners.has(key) || this.recentlyClosed.has(key)) throw new TransportError('OWNER_EXISTS', 'Concurrent activation cannot replace an existing original owner.');
      context.lifecycle.signal?.throwIfAborted();
      const hostValues = new Map(), descriptors = [];
      for (const capability of [...candidate.manifest.requires, ...candidate.manifest.optional]) {
        const value = candidate.manifest.requires.includes(capability) ? context.services.require(capability) : context.services.optional(capability);
        if (value === undefined) continue;
        descriptors.push(describeService(capability, value, this.options.contracts)); hostValues.set(capability, value);
      }
      const owner = new RuntimeOwner({ ...this.options, identity, context, candidate });
      owner.onUnknown = receipt => {
        this.uncertainReceipts.set(JSON.stringify([...identityTuple(identity), receipt.requestId]), { identity: clone(identity, 'original identity'), ...receipt });
        return this.options.archiveUnknown?.({ identity, requestId: receipt.requestId, firstFailure: owner.firstFailure && errorData(owner.firstFailure), receipt });
      };
      owner.onJoined = () => {
        this.owners.delete(key); this.recentlyClosed.set(key, owner.evidence());
        while (this.recentlyClosed.size > 64) this.recentlyClosed.delete(this.recentlyClosed.keys().next().value);
      };
      owner.hostValues = hostValues; owner.allowedServices = new Set(hostValues.keys());
      this.owners.set(key, owner);
      context.effects.adopt(() => owner.retire(), 'join original isolated plugin process and accepted host calls');
      try {
        owner.start();
        const result = await owner.request('prepare', { entryPath: resolved.entryPath, config: clone(candidate.config, 'config'), provides: candidate.manifest.provides, services: descriptors, permissions: context.permissions.list(), contracts: clone(this.options.contracts, 'transport contracts') });
        for (const descriptor of result.services) {
          if (!candidate.manifest.provides.includes(descriptor.capability)) throw new TransportError('INVALID_PROVIDE', 'Undeclared provider.');
          const contract = contractFor(this.options.contracts, descriptor.capability);
          if (descriptor.kind !== contract.kind || (contract.kind === 'async-methods' && JSON.stringify(descriptor.methods) !== JSON.stringify(contract.methods))) throw new TransportError('INVALID_PROVIDE', 'Provider transport differs from its declared contract.');
          context.services.provide(descriptor.capability, serviceProxy(descriptor, (capability, method, args) => owner.request('invoke', { capability, method, args })));
        }
        for (const contribution of result.contributions) context.contributions.register(clone(contribution, 'contribution'));
        context.effects.add(async () => { await owner.request('commit'); owner.state = 'committed'; return () => owner.retire(); }, 'commit isolated plugin effects');
      } catch (error) {
        owner.fail(error);
        try { await owner.stop(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Plugin activation failed; cleanup was not confirmed.'); }
        throw error;
      }
    } });
  }
  observations() { return [...this.recentlyClosed.values(), ...[...this.owners.values()].map(owner => owner.evidence())]; }
  async probe(identity) {
    const owner = this.owners.get(JSON.stringify(identity));
    if (!owner) throw new TransportError('OWNER_REVOKED', 'Original async owner is no longer active.');
    try {
      const response = await owner.request('ping', undefined, Math.min(owner.requestMs, owner.shutdownMs));
      if (response.state !== 'committed') throw new TransportError('INVALID_STATE', 'Original async child is not committed.');
    } catch (error) { owner.fail(error); owner.notifyFailure(error); throw error; }
  }
  uncertainObservations() { return clone([...this.uncertainReceipts.values()], 'original uncertain receipts'); }
}
