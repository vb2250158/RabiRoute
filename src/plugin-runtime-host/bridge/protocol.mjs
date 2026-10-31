import { isDeepStrictEqual, types } from 'node:util';

// Version 1's prepare/commit/dispose envelope is retained. Service calls require a
// separate version: a v1 clone-only peer must never accept an RPC descriptor.
export const version = 2;
export const identityTuple = identity => ['applicationGenerationId', 'managerInstanceId', 'activationId', 'instanceId', 'pluginId', 'version', 'revision', 'host'].map(field => identity[field]);
export class TransportError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'TransportError'; this.code = code; this.details = details; }
}
const outcomeKeys = ['status', 'field', 'operationId', 'receiptId', 'deliveryId', 'uncertain', 'mutationOutcome', 'retryAllowed', 'effectOutcome', 'responseDelivery', 'dispatchStarted'];
/** Local host return/error objects have not crossed IPC yet. Do not execute
 * accessors, proxy traps or user conversion while reading transport metadata. */
export function ownData(value, name) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
export function ownerOutcome(value) {
  const output = {};
  if (!value || typeof value !== 'object' || types.isProxy(value)) return output;
  for (const name of outcomeKeys) {
    const data = ownData(value, name);
    if (['string', 'number', 'boolean'].includes(typeof data)) output[name] = data;
  }
  return output;
}
export function errorData(error) {
  const rawDetails = ownData(error, 'details'), rawCode = ownData(error, 'code'), rawMessage = ownData(error, 'message');
  let details;
  try { details = clone(rawDetails ?? {}, 'error details'); } catch { details = { unavailable: true }; }
  return { code: typeof rawCode === 'string' ? rawCode : 'PLUGIN_FAILED', message: typeof rawMessage === 'string' ? rawMessage : typeof error === 'string' ? error : 'Remote operation failed.', details, ...ownerOutcome(rawDetails), ...ownerOutcome(error) };
}
export function remoteError(data) { return Object.assign(new TransportError(data?.code ?? 'PLUGIN_FAILED', data?.message ?? 'Remote plugin failed.', data?.details), ownerOutcome(data)); }
const binaryPrototypes = new Set([ArrayBuffer, DataView, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array].map(Type => Type.prototype));
export function assertDataDTO(value, location, seen = new WeakSet()) {
  if (value === null || ['undefined', 'string', 'boolean', 'number', 'bigint'].includes(typeof value)) return;
  if (typeof value !== 'object') throw new TransportError('UNSUPPORTED_SERVICE_TRANSPORT', `Behavior-bearing value at ${location}.`, { path: location });
  if (types.isProxy(value)) throw new TransportError('UNSUPPORTED_SERVICE_TRANSPORT', `Proxy value at ${location} needs an explicit data adapter.`, { path: location });
  if (seen.has(value)) return;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (![Object.prototype, null, Array.prototype, Date.prototype, RegExp.prototype, Map.prototype, Set.prototype].includes(prototype) && !binaryPrototypes.has(prototype)) throw new TransportError('UNSUPPORTED_SERVICE_TRANSPORT', `Custom class/prototype at ${location} needs an explicit data adapter.`, { path: location });
  for (const name of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (typeof name !== 'string' || !('value' in descriptor)) throw new TransportError('UNSUPPORTED_SERVICE_TRANSPORT', `Accessor/symbol at ${location} needs an explicit data adapter.`, { path: location });
    assertDataDTO(descriptor.value, `${location}.${name}`, seen);
  }
  if (prototype === Map.prototype) for (const [key, entry] of Map.prototype.entries.call(value)) { assertDataDTO(key, `${location}.key`, seen); assertDataDTO(entry, `${location}.value`, seen); }
  if (prototype === Set.prototype) for (const entry of Set.prototype.values.call(value)) assertDataDTO(entry, `${location}.value`, seen);
}
export function clone(value, path) {
  assertDataDTO(value, path);
  try { return structuredClone(value); }
  catch { throw new TransportError('UNSUPPORTED_SERVICE_TRANSPORT', `Non-cloneable value at ${path}.`, { path }); }
}
export function contractFor(contracts, capability) {
  const contract = Object.hasOwn(contracts, capability) ? contracts[capability] : undefined;
  if (!contract || !['data', 'async-methods', 'unsupported'].includes(contract.kind)) throw new TransportError('UNSUPPORTED_SERVICE_TRANSPORT', `Capability ${capability} has no explicit data or asynchronous transport contract.`, { capability });
  if (contract.kind === 'async-methods' && (!Array.isArray(contract.methods) || !contract.methods.length || new Set(contract.methods).size !== contract.methods.length || contract.methods.some(name => typeof name !== 'string' || !name || ['__proto__', 'constructor', 'prototype', 'then'].includes(name)))) throw new TransportError('INVALID_TRANSPORT_CONTRACT', `Invalid asynchronous methods for ${capability}.`);
  return contract;
}
export function describeService(capability, value, contracts) {
  const contract = contractFor(contracts, capability);
  if (contract.kind === 'unsupported') return { capability, kind: 'unsupported' };
  if (contract.kind === 'data') return { capability, kind: 'data', value: clone(value, capability) };
  if (!value || typeof value !== 'object') throw new TransportError('UNSUPPORTED_SERVICE_TRANSPORT', `${capability} must be an object with explicit async methods.`);
  if (types.isProxy(value)) throw new TransportError('UNSUPPORTED_SERVICE_TRANSPORT', `Proxy service ${capability} needs an explicit adapter.`, { capability });
  const data = Object.create(null);
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) throw new TransportError('UNSUPPORTED_SERVICE_TRANSPORT', `Accessor ${capability}.${name} cannot be transported.`, { capability, member: name });
    if (contract.methods.includes(name)) {
      if (typeof descriptor.value !== 'function') throw new TransportError('UNSUPPORTED_SERVICE_TRANSPORT', `Missing async method ${capability}.${name}.`);
    } else data[name] = clone(descriptor.value, `${capability}.${name}`);
  }
  for (const name of contract.methods) if (!Object.hasOwn(value, name) || typeof value[name] !== 'function') throw new TransportError('UNSUPPORTED_SERVICE_TRANSPORT', `Missing own async method ${capability}.${name}.`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TransportError('UNSUPPORTED_SERVICE_TRANSPORT', `Class/prototype service ${capability} needs an explicit adapter.`, { capability });
  return { capability, kind: 'async-methods', methods: [...contract.methods], data };
}
export function serviceProxy(descriptor, invoke) {
  if (descriptor.kind === 'data') return clone(descriptor.value, descriptor.capability);
  const result = Object.assign(Object.create(null), clone(descriptor.data, descriptor.capability));
  for (const method of descriptor.methods) result[method] = (...args) => invoke(descriptor.capability, method, clone(args, `${descriptor.capability}.${method}.arguments`));
  return Object.freeze(result);
}
export function validEnvelope(message, nonce, identity) {
  return message && typeof message === 'object' && message.protocolVersion === version && message.nonce === nonce && isDeepStrictEqual(message.identity, identity) && typeof message.requestId === 'string' && message.requestId.length > 0 && Number.isSafeInteger(message.sequence) && message.sequence > 0;
}
export function envelope(nonce, identity, requestId, sequence, body) { return { protocolVersion: version, nonce, identity, requestId, sequence, ...body }; }
