import { createApiCatalogClient, validateDiscoveredApiOperation } from './api-catalog-client.mjs';
import { decodeManagerJsonReceipt } from './operation-result.mjs';

const DISCOVERY_ROOT = '/api/agent/operations';

export function decodeOperationBytes(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError('Binary input requires canonical base64.');
  }
  if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64');
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

export function encodeOperationBytes(value) {
  if (typeof Buffer !== 'undefined') return Buffer.from(value).toString('base64');
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}


export class OperationSdkError extends Error {
  constructor(message, receipt, details) {
    super(message);
    this.name = 'OperationSdkError';
    this.receipt = receipt;
    this.details = details;
    this.code = details?.errorCode ?? 'API_DISCOVERY_UNAVAILABLE';
  }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function queryString(values) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') query.set(name, String(value));
  }
  return query.size ? '?' + query : '';
}

/** Keep HTTP outcome, identity and receipts alongside the decoded business result. */
export function operationResult(receipt, operation, requestId) {
  const decoded = decodeManagerJsonReceipt(receipt);
  const { body, bodyBytes, bodyJson, bodyBase64, ...metadata } = decoded;
  let data;
  try { data = bodyJson ?? (typeof body === 'string' ? JSON.parse(body) : body); } catch { data = undefined; }
  const result = { ...metadata, operation, ...(requestId ? { requestId } : {}) };
  if (data !== undefined) {
    result.ok = decoded.ok && !(typeof data?.code === 'number' && data.code < 0);
    result.data = data;
  } else if (body !== undefined) result.body = body;
  if (data === undefined && bodyBytes !== undefined) result.bodyBase64 = encodeOperationBytes(bodyBytes);
  else if (data === undefined && bodyBase64 !== undefined) result.bodyBase64 = bodyBase64;
  return result;
}

/** One discovery/call model for CLI, MCP and native adapters. The transport owns authentication. */
export function createOperationSdk(dependencies) {
  const { request } = dependencies;
  if (typeof request !== 'function') throw new TypeError('An existing Manager request transport is required.');
  const descriptions = new Map();
  const pending = new Map();
  let snapshotKey;
  let latestSnapshot;
  let readSequence = 0;
  let appliedSequence = 0;
  let epoch = 0;

  function invalidate() {
    epoch++;
    descriptions.clear();
    pending.clear();
    snapshotKey = undefined;
    latestSnapshot = undefined;
  }

  function verifySnapshot(data, receipt, sequence) {
    if (data?.schemaVersion !== '2' || !data.applicationGenerationId || !data.managerInstanceId
      || !data.pluginGenerationId || !Number.isSafeInteger(data.catalogRevision) || typeof data.catalogDigest !== 'string') {
      throw new OperationSdkError('Manager returned an incomplete discovery snapshot.', receipt);
    }
    if (receipt.identity && (receipt.identity.applicationGenerationId !== data.applicationGenerationId
      || receipt.identity.managerInstanceId !== data.managerInstanceId)) {
      invalidate();
      throw new OperationSdkError('Discovery and transport refer to different Manager generations.', receipt);
    }
    if (latestSnapshot) {
      const sameManager = data.applicationGenerationId === latestSnapshot.applicationGenerationId
        && data.managerInstanceId === latestSnapshot.managerInstanceId;
      if (sameManager && data.catalogRevision < latestSnapshot.catalogRevision || !sameManager && sequence < appliedSequence) {
        throw new OperationSdkError('A newer discovery snapshot is already available.', receipt,
          { errorCode: 'API_CATALOG_SNAPSHOT_CHANGED', field: 'catalogRevision', repair: 'Read the current operation description.' });
      }
    }
    const key = JSON.stringify([data.applicationGenerationId, data.managerInstanceId, data.catalogRevision, data.catalogDigest]);
    if (snapshotKey && snapshotKey !== key) descriptions.clear();
    snapshotKey = key;
    latestSnapshot = data;
    appliedSequence = Math.max(appliedSequence, sequence);
    return data;
  }

  async function read(path, options = {}, cached) {
    const sequence = ++readSequence;
    const headers = cached?.etag ? { 'if-none-match': cached.etag } : {};
    const receipt = await request('GET', path, { headers, signal: options.signal, timeoutMs: options.timeoutMs, replaySafe: false });
    if (receipt.statusCode === 304 && cached) {
      if (receipt.uncertain || receipt.identityChanged || receipt.identity &&
        (receipt.identity.applicationGenerationId !== cached.data.applicationGenerationId
          || receipt.identity.managerInstanceId !== cached.data.managerInstanceId)) {
        invalidate();
        throw new OperationSdkError('Conditional discovery belongs to a retired Manager generation.', receipt);
      }
      verifySnapshot(cached.data, receipt, sequence);
      return cached;
    }
    let envelope;
    try { envelope = JSON.parse(receipt.body); } catch { /* Preserve the actual transport outcome below. */ }
    if (!receipt.ok || receipt.uncertain || receipt.identityChanged || envelope?.code !== 0) {
      throw new OperationSdkError(envelope?.message || 'Read the reported discovery error and its repair entry.', receipt, envelope);
    }
    return { data: verifySnapshot(envelope.data, receipt, sequence), etag: receipt.headers?.etag };
  }

  async function categories(options = {}) {
    return (await read('/api/agent/categories', options)).data;
  }

  async function list(filters = {}, options = {}) {
    object(filters, 'Discovery filters');
    return (await read(DISCOVERY_ROOT + queryString(filters), options)).data;
  }

  async function search(query, filters = {}, options = {}) {
    if (typeof query !== 'string' || !query.trim()) throw new TypeError('Search query must be nonempty.');
    return list({ ...filters, query }, options);
  }

  async function describe(operation, options = {}) {
    if (typeof operation !== 'string' || !operation.trim()) throw new TypeError('A discovered operation ID is required.');
    const view = options.view ?? 'input';
    if (!['input', 'result', 'full'].includes(view)) throw new TypeError('Describe view is input, result or full.');
    const key = operation + '\0' + view;
    if (options.cached && descriptions.has(key)) return descriptions.get(key).data;
    if (pending.has(key)) return pending.get(key);
    const observed = epoch;
    const work = (async () => {
      const result = await read(DISCOVERY_ROOT + '/' + encodeURIComponent(operation) + queryString({ view }), options,
        options.force ? undefined : descriptions.get(key));
      if (epoch !== observed) throw new OperationSdkError('Discovery changed during the read; retain the original intent and read its current contract.');
      if (!result.data.operation || typeof result.data.operation.id !== 'string') {
        throw new OperationSdkError('The requested operation is absent from this description.', undefined, { errorCode: 'AGENT_HELP_NOT_FOUND' });
      }
      descriptions.set(key, result);
      return result.data;
    })();
    pending.set(key, work);
    try { return await work; } finally { if (pending.get(key) === work) pending.delete(key); }
  }

  const execution = createApiCatalogClient({ ...dependencies, onInvalidate: invalidate,
    resolveOperation: async (operation, options) => {
      const data = await describe(operation, { signal: options.signal, timeoutMs: options.timeoutMs, view: 'full', cached: true });
      validateDiscoveredApiOperation(data.operation);
      return { operation: data.operation, snapshot: data };
    }
  });

  function optionsFor(input = {}, options = {}) {
    object(input, 'Operation input');
    const { pathParams, path, query = {}, headers = {}, body, bodyBase64, ...native } = input;
    if (bodyBase64 !== undefined) {
      if (body !== undefined || native.bodyBytes !== undefined || native.bodyText !== undefined || native.bodyStream !== undefined) throw new TypeError('Choose one operation body representation.');
      native.bodyBytes = decodeOperationBytes(bodyBase64);
    }
    const requestHeaders = { ...headers };
    const key = options.idempotencyKey ?? options.requestId;
    if (key !== undefined) {
      if (typeof key !== 'string' || !key.trim()) throw new TypeError('Request identity must be nonempty.');
      const existing = Object.keys(requestHeaders).find(name => name.toLowerCase() === 'idempotency-key');
      if (existing && requestHeaders[existing] !== key) throw new TypeError('The request carries conflicting idempotency keys.');
      requestHeaders[existing ?? 'idempotency-key'] = key;
    }
    if (options.expectedRevision !== undefined) requestHeaders['if-match'] = options.expectedRevision;
    const { requestId, idempotencyKey, expectedRevision, ...transportOptions } = options;
    return { ...native, ...transportOptions, path: pathParams ?? path ?? {}, query, headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  }

  function prepare(operation, input = {}, options = {}) {
    return execution.prepareOperation(operation, optionsFor(input, options));
  }

  async function invokeOperation(operation, input = {}, options = {}) {
    return execution.invokeOperation(operation, optionsFor(input, options));
  }

  async function call(operation, input = {}, options = {}) {
    return operationResult(await invokeOperation(operation, input, options), operation, options.requestId ?? options.idempotencyKey);
  }

  function openOperation(operation, input = {}, options = {}) {
    return execution.openOperation(operation, optionsFor(input, options));
  }

  return Object.freeze({ categories, list, search, describe, prepare, call, invokeOperation, openOperation, request,
    invalidate: execution.invalidate, handleEvent: execution.handleEvent, watch: execution.watch });
}
