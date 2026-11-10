import { randomUUID } from 'node:crypto';
import { decodeOperationBytes } from '../../rabi-agent/lib/operation-sdk.mjs';
import { operationIsReadOnly } from '../../rabi-agent/lib/operation-tool-definitions.mjs';
import { KnowledgePolicyError } from './knowledge-tools.mjs';
import { parseApiPathTemplate } from '../../rabi-agent/lib/api-path-template.mjs';
import { decodeManagerJsonReceipt } from './manager-client.mjs';

const object = properties => ({ type: 'object', properties, additionalProperties: false });
const string = { type: 'string' };
const optionsSchema = object({
  path: { type: 'object' }, query: { type: 'object' }, headers: { type: 'object', additionalProperties: string },
  nativeHeaders: { type: 'object', additionalProperties: string, description: 'Explicit credentials for a discovered native listener only; Manager transport credentials cannot be overridden.' },
  method: string, body: {}, bodyText: string, bodyBase64: string,
  responseMode: { enum: ['text', 'bytes', 'stream'] },
  timeoutMs: { type: 'integer', minimum: 1 }, maxResponseBytes: { type: 'integer', minimum: 1 },
  outputPath: { ...string, description: 'Explicit local output file; uses the original non-overwriting download/output owner.' },
  protocols: { type: 'array', items: string }
});
const definitions = [
  { name: 'rabi_api_list', readOnly: true, description: 'Discover all current public Rabi operations, including newly installed plugins. This is discovery, not execution. Optional filters affect this result only.', inputSchema: object({ query: string, transport: string, cursor: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }) },
  { name: 'rabi_api_describe', readOnly: true, description: 'Read the current executable operation contract: request/response schemas, effects, recovery, transport and native listener requirements.', inputSchema: { ...object({ operationId: string }), required: ['operationId'] } },
  { name: 'rabi_api_call', readOnly: false, description: 'Call any discovered public Rabi operation through the original Manager client. Preserve its revision, idempotency and receipt contract. JSON/text/bytes return the original receipt; SSE/stream and WebSocket return a live session, not business completion. RABI_MCP_ALLOW_WRITES=false rejects state-changing calls; RABI_MCP_ALLOWED_ROLES constrains role targets. Settings belong to the MCP launch environment.', inputSchema: { ...object({ operationId: string, options: optionsSchema }), required: ['operationId'] } },
  { name: 'rabi_api_session', readOnly: false, description: 'Read queued stream/WebSocket frames, send a WebSocket frame, or close the original session. Read never replays a business request. A sent frame is transport acknowledgement only. Close cancels and releases the session. Sessions end when this MCP process exits.', inputSchema: { ...object({ sessionId: string, action: { enum: ['read', 'send', 'close'] }, text: string, base64: string, json: {} }), required: ['sessionId', 'action'] } }
];

const own = (value, key) => Object.hasOwn(value, key);
function argumentsObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new KnowledgePolicyError('Invalid API tool arguments; use its declared input schema.');
}
function requiredString(value) {
  if (typeof value !== 'string' || !value.trim()) throw new KnowledgePolicyError('A non-empty operationId or sessionId is required.');
}
function bytes(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new KnowledgePolicyError('Binary data requires canonical base64.');
  return decodeOperationBytes(value);
}
function serializedReceipt(receipt) {
  const { bodyBytes, ...value } = receipt;
  if (bodyBytes !== undefined) value.bodyBase64 = Buffer.from(bodyBytes).toString('base64');
  return value;
}
function roleTargets(value, schema, found = new Set(), root = schema, depth = 0) {
  if (!value || typeof value !== 'object' || !schema || typeof schema !== 'object') return found;
  if (depth > 64) throw new KnowledgePolicyError('Role scope exceeds the supported schema depth under RABI_MCP_ALLOWED_ROLES; simplify the request or edit that launch setting.');
  if (schema.$ref?.startsWith('#/')) {
    const resolved = schema.$ref.slice(2).split('/').reduce((parent, key) => parent?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], root);
    roleTargets(value, resolved, found, root, depth + 1);
  }
  for (const group of ['allOf', 'anyOf', 'oneOf']) for (const child of schema[group] ?? []) roleTargets(value, child, found, root, depth + 1);
  if (Array.isArray(value)) {
    for (const child of value) roleTargets(child, schema.items, found, root, depth + 1);
  } else for (const [key, field] of Object.entries(schema.properties ?? {})) {
    const child = value[key];
    if (/^(?:roleIds?|personaIds?|targetRoleIds?|targetPersonaIds?)$/.test(key)) {
      for (const role of Array.isArray(child) ? child : [child]) if (typeof role === 'string') found.add(role);
    }
    else roleTargets(child, field, found, root, depth + 1);
  }
  return found;
}
function jsonPolicyBody(contract, options) {
  if (contract.request?.body?.kind !== 'json') return undefined;
  const raw = own(options, 'bodyBytes') ? options.bodyBytes.toString('utf8') : own(options, 'bodyText') ? options.bodyText : options.body;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); }
  catch { throw new KnowledgePolicyError('A valid JSON body is required to apply RABI_MCP_ALLOWED_ROLES; use the operation schema or edit that launch setting.'); }
}

/** Protocol adapter only: discovery and native clients own contracts, identity and execution. */
export function createApiTools({ client, progressive = false, allowedRoles, allowWrites = true, maxSessions = 16, maxSessionBytes = 1024 * 1024 } = {}) {
  const hasDiscovery = progressive ? typeof client?.operations?.describe === 'function' : typeof client?.catalog?.refresh === 'function';
  if (!hasDiscovery || typeof client?.invokeOperation !== 'function' || typeof client?.openOperation !== 'function') throw new TypeError('The shared Manager API client is required.');
  if (typeof allowWrites !== 'boolean' || allowedRoles !== undefined && (!Array.isArray(allowedRoles) || allowedRoles.some(role => typeof role !== 'string' || !role.trim())) || !Number.isSafeInteger(maxSessions) || maxSessions < 1 || !Number.isSafeInteger(maxSessionBytes) || maxSessionBytes < 1) throw new TypeError('Invalid MCP API policy or session budget.');
  const roles = allowedRoles === undefined ? undefined : new Set(allowedRoles);
  const sessions = new Map();
  let closed = false;
  const policy = (entry, options) => {
    const contract = entry.contract, method = options.method ?? contract.method;
    if (!allowWrites && !operationIsReadOnly(contract, method)) throw new KnowledgePolicyError('Call disabled by RABI_MCP_ALLOW_WRITES=false in the MCP launch environment; edit that setting to allow state-changing operations.');
    if (roles) {
      const names = parseApiPathTemplate(contract.pathTemplate, contract.request?.pathTails, contract.request?.pathRemainder).names;
      const targets = roleTargets(options.path, { properties: Object.fromEntries(names.map(name => [name, true])) });
      roleTargets(options.query, contract.request?.query, targets);
      roleTargets(jsonPolicyBody(contract, options), contract.request?.body?.schema, targets);
      if ([...targets].some(role => !roles.has(role)) || /\/(?:roles|personas)(?:\/|$)/.test(contract.pathTemplate) && targets.size === 0) throw new KnowledgePolicyError('Role target excluded or unspecified under RABI_MCP_ALLOWED_ROLES in the MCP launch environment; select an allowed role or edit/remove that configured list. Unscoped non-role operations remain available.');
    }
  };
  const catalog = signal => client.catalog.refresh({ signal });
  const entryFor = (snapshot, id) => {
    const entry = snapshot.operations.find(item => item.id === id || item.contract.aliases?.includes(id));
    if (!entry) throw new KnowledgePolicyError('Operation absent from current public discovery; use rabi_api_list before preparing a call. No business request was sent.');
    return entry;
  };
  const operation = async (id, signal) => {
    if (progressive && client.operations) return (await client.operations.describe(id, { view: 'full', signal })).operation;
    const snapshot = client.catalog.getSnapshot?.();
    if (snapshot?.operations.some(item => item.id === id || item.contract.aliases?.includes(id))) return entryFor(snapshot, id);
    return entryFor(await catalog(signal), id);
  };
  const append = async (session, frame, nativeSignal) => {
    const signal = nativeSignal ? AbortSignal.any([session.controller.signal, nativeSignal]) : session.controller.signal;
    const size = Buffer.byteLength(JSON.stringify(frame));
    // The native reader awaits its consumer. A high-water mark pauses producers,
    // and an individual legal WebSocket frame is admitted without a new ceiling.
    while (session.bytes > 0 && session.bytes + size > maxSessionBytes) {
      signal.throwIfAborted();
      await new Promise((resolve, reject) => {
        const ready = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal.reason); };
        const cleanup = () => { session.space.delete(ready); signal.removeEventListener('abort', abort); };
        session.space.add(ready); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
    session.queue.push(frame); session.bytes += size;
  };
  async function call(name, args = {}, context = {}) {
    if (closed) throw new KnowledgePolicyError('MCP API adapter is closed.');
    if (name === 'rabi_api_list') {
      argumentsObject(args, ['query', 'transport', 'cursor', 'limit']);
      if (args.query !== undefined && typeof args.query !== 'string' || args.transport !== undefined && typeof args.transport !== 'string' || args.cursor !== undefined && (!Number.isSafeInteger(args.cursor) || args.cursor < 0) || args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 200)) throw new KnowledgePolicyError('Invalid discovery filter or page size (1-200).');
      const snapshot = await catalog(context.signal), query = args.query?.toLowerCase();
      const entries = snapshot.operations.filter(item => (!query || `${item.id} ${item.contract.pathTemplate} ${item.contract.description}`.toLowerCase().includes(query)) && (!args.transport || (item.contract.transport ?? 'http') === args.transport));
      const cursor = args.cursor ?? 0, limit = args.limit ?? 100;
      return { ok: true, data: { applicationGenerationId: snapshot.applicationGenerationId, managerInstanceId: snapshot.managerInstanceId, catalogDigest: snapshot.catalogDigest, total: entries.length, nextCursor: cursor + limit < entries.length ? cursor + limit : null, operations: entries.slice(cursor, cursor + limit).map(item => ({ id: item.id, method: item.contract.method, pathTemplate: item.contract.pathTemplate, transport: item.contract.transport ?? 'http', description: item.contract.description, effects: item.contract.effects, binding: item.binding })) } };
    }
    if (name === 'rabi_api_describe') {
      argumentsObject(args, ['operationId']); requiredString(args.operationId);
      return { ok: true, data: await operation(args.operationId, context.signal) };
    }
    if (name === 'rabi_api_session') {
      argumentsObject(args, ['sessionId', 'action', 'text', 'base64', 'json']); requiredString(args.sessionId);
      const session = sessions.get(args.sessionId);
      if (!session && args.action === 'close') return { ok: true, state: 'not_present', sessionId: args.sessionId, businessCompletion: false };
      if (!session) throw new KnowledgePolicyError('Session not found in this MCP process; do not recreate or replay its business request.');
      if (args.action === 'close') {
        session.controller.abort(); session.channel?.close();
        await session.flight; sessions.delete(args.sessionId);
        return { ok: !session.error, state: 'closed', sessionId: args.sessionId, operation: session.operation, requestId: session.requestId, ...(session.error ? { error: session.error } : {}), receipt: session.receipt };
      }
      if (args.action === 'read') {
        const frames = session.queue.splice(0); session.bytes = 0;
        for (const ready of [...session.space]) ready();
        const released = ['completed', 'closed', 'failed'].includes(session.state);
        if (released) sessions.delete(args.sessionId);
        return { ok: !session.error, sessionId: args.sessionId, operation: session.operation, requestId: session.requestId, state: session.state, frames, businessCompletion: 'inspect_original_receipt', released, ...(session.error ? { error: session.error } : {}), ...(session.receipt ? { receipt: session.receipt } : {}) };
      }
      if (args.action !== 'send' || session.transport !== 'websocket' || !session.channel || session.state !== 'open') throw new KnowledgePolicyError('Send requires an open WebSocket session; use read or close for an HTTP stream.');
      if (!allowWrites) throw new KnowledgePolicyError('WebSocket frame sends disabled by RABI_MCP_ALLOW_WRITES=false in the MCP launch environment.');
      if (['text', 'base64', 'json'].filter(key => own(args, key)).length !== 1 || own(args, 'text') && typeof args.text !== 'string') throw new KnowledgePolicyError('Choose one frame: text, base64 or json.');
      if (own(args, 'json')) await session.channel.sendJsonAsync(args.json);
      else await session.channel.sendAsync(own(args, 'base64') ? bytes(args.base64) : args.text);
      return { ok: true, sessionId: args.sessionId, operation: session.operation, requestId: session.requestId, state: 'frame_sent', businessCompletion: false };
    }
    if (name !== 'rabi_api_call') throw new KnowledgePolicyError('Unknown API tool.');
    argumentsObject(args, ['operationId', 'options']); requiredString(args.operationId);
    const options = { ...(args.options ?? {}) };
    argumentsObject(args.options ?? {}, Object.keys(optionsSchema.properties));
    const entry = await operation(args.operationId, context.signal);
    if (closed) throw new KnowledgePolicyError('MCP API adapter is closed.');
    if (own(options, 'bodyBase64')) { options.bodyBytes = bytes(options.bodyBase64); delete options.bodyBase64; }
    policy(entry, options);
    if (entry.binding?.invocation === 'discovery-only') return { ok: false, state: 'not_started', error: 'NATIVE_CONNECTOR_REQUIRED', noReplay: true,
      operationId: entry.id, binding: entry.binding, message: 'This public listener requires the native protocol connector and authentication described by its binding; no business request was sent.' };
    const transport = entry.contract.transport ?? 'http';
    if (options.outputPath !== undefined || transport !== 'websocket' && transport !== 'sse' && options.responseMode !== 'stream') {
      const successResponses = Object.entries(entry.contract.responses ?? {}).filter(([status]) => /^2\d\d$/.test(status)).map(([, response]) => response.mediaType);
      const defaultMode = successResponses.length && successResponses.every(type => typeof type === 'string' && /^(?:text\/|application\/(?:json|xml|javascript)|[^;]+\+(?:json|xml))/.test(type)) ? 'text' : 'bytes';
      const receipt = decodeManagerJsonReceipt(await client.invokeOperation(args.operationId, { ...options, responseMode: options.responseMode ?? defaultMode, signal: context.signal }));
      if (receipt.bodyJson !== undefined) receipt.data = receipt.bodyJson;
      if (receipt.bodyBytes !== undefined) {
        const type = receipt.headers?.['content-type'] ?? '';
        if (/^(?:text\/|application\/(?:json|xml|javascript)|[^;]+\+(?:json|xml))/.test(type)) {
          receipt.body = Buffer.from(receipt.bodyBytes).toString('utf8'); delete receipt.bodyBytes;
          if (receipt.bodyJson === undefined) try { receipt.data = JSON.parse(receipt.body); } catch { /* Preserve non-JSON text. */ }
        }
      }
      return { ...serializedReceipt(receipt), businessCompletion: 'inspect_original_receipt' };
    }
    if ([...sessions.values()].filter(session => ['opening', 'running', 'open'].includes(session.state)).length >= maxSessions) throw new KnowledgePolicyError('MCP active session capacity reached; close an active rabi_api_session or adjust RABI_MCP_MAX_SESSIONS in the MCP launch environment.');
    const retainedBytes = [...sessions.values()].filter(session => !['opening', 'running', 'open'].includes(session.state))
      .reduce((sum, session) => sum + session.bytes + Buffer.byteLength(JSON.stringify(session.receipt ?? {})), 0);
    if (retainedBytes >= maxSessions * maxSessionBytes) throw new KnowledgePolicyError('Unread completed MCP session results occupy the retained byte budget; read or close them, or adjust RABI_MCP_MAX_SESSIONS / RABI_MCP_MAX_SESSION_BYTES in the launch environment. Original results were retained.');
    const sessionId = randomUUID(), controller = new AbortController();
    const requestKey = Object.entries(options.headers ?? {}).find(([name]) => name.toLowerCase() === 'idempotency-key')?.[1];
    const session = { controller, transport, operation: args.operationId, requestId: requestKey, queue: [], bytes: 0, space: new Set(), state: 'opening' };
    sessions.set(sessionId, session);
    if (transport === 'websocket') {
      const cancelOpening = () => controller.abort();
      context.signal?.addEventListener('abort', cancelOpening, { once: true });
      if (context.signal?.aborted) controller.abort();
      try {
        const opening = client.openOperation(args.operationId, { ...options, signal: controller.signal, drainOnRemoteClose: true, onMessage(value, info) { return append(session, info?.binary || value instanceof Uint8Array ? { encoding: 'base64', data: Buffer.from(value).toString('base64') } : { encoding: typeof value === 'string' ? 'text' : 'json', data: value }, info?.signal); } });
        session.flight = opening.then(channel => { session.channel = channel; if (controller.signal.aborted) channel.close(); return channel.closed; })
          .then(receipt => { session.receipt = receipt; session.error ??= receipt.errorCode; session.state = 'closed'; controller.abort(); }, () => { session.state = 'failed'; session.error ??= 'WEBSOCKET_FAILED'; controller.abort(); });
        session.channel = await opening;
        if (controller.signal.aborted) { await session.flight; return { ok: false, state: 'closed', noReplay: true }; }
        session.state = 'open';
      } catch { sessions.delete(sessionId); controller.abort(); return { ok: false, state: 'not_opened', error: 'WEBSOCKET_OPEN_FAILED', noReplay: true }; }
      finally { context.signal?.removeEventListener('abort', cancelOpening); }
    } else {
      session.state = 'running';
      session.flight = client.invokeOperation(args.operationId, { ...options, responseMode: 'stream', signal: controller.signal,
        onChunk(chunk) { return append(session, { encoding: 'base64', data: Buffer.from(chunk).toString('base64') }); }
      }).then(receipt => { session.receipt = serializedReceipt(receipt); session.state = 'completed'; if (!receipt.ok || receipt.uncertain) session.error ??= receipt.transportError ?? 'STREAM_NOT_CONFIRMED'; controller.abort(); }, () => { session.state = 'failed'; session.error ??= 'STREAM_FAILED'; controller.abort(); });
    }
    return { ok: true, state: session.state, sessionId, operation: session.operation, requestId: session.requestId, transport, businessCompletion: false, queueHighWaterBytes: maxSessionBytes };
  }
  return Object.freeze({ list: () => definitions.map(definition => ({ ...definition })), call, async close() {
    closed = true;
    for (const session of sessions.values()) { session.controller.abort(); session.channel?.close(); }
    await Promise.allSettled([...sessions.values()].map(session => session.flight)); sessions.clear();
  } });
}

export function combineMcpTools(...groups) {
  const owners = new Map();
  for (const group of groups) for (const definition of group.list()) {
    if (owners.has(definition.name)) throw new Error('Duplicate MCP tool name.');
    owners.set(definition.name, group);
  }
  return Object.freeze({ list: () => groups.flatMap(group => group.list()), call(name, args, context) {
    const owner = owners.get(name);
    if (!owner) throw new KnowledgePolicyError('Unknown MCP tool.');
    return owner.call(name, args, context);
  }, close: () => Promise.allSettled(groups.map(group => group.close?.())) });
}
