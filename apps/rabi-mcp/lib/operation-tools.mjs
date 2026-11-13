import { createApiTools, combineMcpTools } from './api-tools.mjs';
import { operationResult, OperationSdkError } from '../../rabi-agent/lib/operation-sdk.mjs';

import { OPERATION_TOOL_DEFINITIONS as definitions } from '../../rabi-agent/lib/operation-tool-definitions.mjs';

function argumentError(name, field, properties, message) {
  return new OperationSdkError(message, undefined, { errorCode: 'TOOL_ARGUMENTS_INVALID', field,
    repair: `Read ${name} input schema. Accepted fields: ${Object.keys(properties ?? {}).join(', ')}.` });
}

/** Session budgets belong to the MCP host's launch configuration. */
export function readOperationSessionSettings(env = process.env) {
  const read = (name, fallback) => {
    if (env[name] === undefined) return fallback;
    const value = Number(env[name]);
    if (!env[name].trim() || !Number.isSafeInteger(value) || value < 1)
      throw new TypeError(`${name} must be a positive safe integer in the MCP launch environment.`);
    return value;
  };
  return { maxSessions: read('RABI_MCP_MAX_SESSIONS', 16), maxSessionBytes: read('RABI_MCP_MAX_SESSION_BYTES', 1024 * 1024) };
}

/** MCP owns tool presentation and live stream sessions, while the SDK owns discovery and invocation. */
export function createOperationTools({ client, ...policy }) {
  const sdk = client?.operations;
  if (!sdk) throw new TypeError('The shared operation SDK is required.');
  const nativeOptions = options => {
    const { path, body, ...rest } = options;
    let value = body;
    if (typeof body === 'string') { try { value = JSON.parse(body); } catch { return { ...rest, pathParams: path, bodyText: body }; } }
    return { ...rest, pathParams: path, ...(body === undefined ? {} : { body: value }) };
  };
  const sessions = createApiTools({ ...policy, progressive: true, client: {
    ...client, operations: sdk,
    invokeOperation: (id, options) => sdk.invokeOperation(id, nativeOptions(options)),
    openOperation: (id, options) => sdk.openOperation(id, nativeOptions(options))
  } });
  async function call(name, args = {}, context = {}) {
    const definition = definitions.find(item => item.name === name);
    if (!definition || !args || typeof args !== 'object' || Array.isArray(args)) throw argumentError(name, 'arguments', definition?.inputSchema.properties, 'Use a listed Rabi tool with an argument object.');
    const fields = definition.inputSchema.properties;
    const unknown = Object.keys(args).find(key => !Object.hasOwn(fields, key));
    if (unknown) throw argumentError(name, unknown, fields, `Unknown ${name} argument ${unknown}.`);
    const missing = (definition.inputSchema.required ?? []).find(key => args[key] === undefined);
    if (missing) throw argumentError(name, missing, fields, `${name} requires ${missing}.`);
    for (const [key, value] of Object.entries(args)) {
      const field = fields[key];
      if (field.type === 'string' && typeof value !== 'string' || field.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))
        || field.enum && !field.enum.includes(value)) throw argumentError(name, key, fields, `Invalid ${name} argument ${key}.`);
    }

    if (name === 'rabi_categories') return { ok: true, data: await sdk.categories({ signal: context.signal }) };
    if (name === 'rabi_list') return { ok: true, data: await sdk.list(args, { signal: context.signal }) };
    if (name === 'rabi_search') { const { query, ...filters } = args; return { ok: true, data: await sdk.search(query, filters, { signal: context.signal }) }; }
    if (name === 'rabi_describe') return { ok: true, data: await sdk.describe(args.operation, { view: args.view ?? 'input', signal: context.signal }) };
    if (name === 'rabi_session') return sessions.call('rabi_api_session', args, context);
    if (name !== 'rabi_call') throw new Error('Unknown Rabi operation tool.');
    const options = { ...(args.input ?? {}) };
    if (Object.hasOwn(options, 'body')) options.body = JSON.stringify(options.body);
    if (options.pathParams !== undefined) { options.path = options.pathParams; delete options.pathParams; }
    const headers = { ...(options.headers ?? {}) };
    const key = args.idempotencyKey ?? args.requestId;
    if (key !== undefined) {
      const previous = Object.keys(headers).find(name => name.toLowerCase() === 'idempotency-key');
      if (previous && headers[previous] !== key) throw new Error('Conflicting original request identities.');
      headers[previous ?? 'idempotency-key'] = key;
    }
    if (args.expectedRevision !== undefined) headers['if-match'] = args.expectedRevision;
    options.headers = headers;
    const receipt = await sessions.call('rabi_api_call', { operationId: args.operation, options }, context);
    return typeof receipt.statusCode === 'number' ? operationResult(receipt, args.operation, args.requestId ?? args.idempotencyKey) : receipt;
  }
  return Object.freeze({ list: () => definitions.map(item => structuredClone(item)), call, close: () => sessions.close() });
}
export { combineMcpTools };
