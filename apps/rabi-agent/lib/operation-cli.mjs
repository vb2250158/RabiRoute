import fs from 'node:fs/promises';
import { runManagerWebSocketCommand } from './manager-websocket-cli.mjs';

export const OPERATION_COMMANDS = Object.freeze(['categories', 'list', 'search', 'describe', 'call']);

/** argv and files are presentation; the injected SDK owns all operation semantics. */
export async function runOperationCommand(args, sdk, { readInput = async () => '', inputStream, signal, redact = value => value, protectedCredential } = {}) {
  const [command, ...values] = args;
  if (!OPERATION_COMMANDS.includes(command)) throw new Error('Use categories, list, search, describe or call.');
  const common = ['--config', '--agent-type', '--id', '--timeout-ms'];
  const discovery = ['--category', '--provider', '--owner', '--method', '--path-prefix', '--query', '--limit', '--cursor'];
  const commandFlags = {
    categories: [], list: discovery, search: discovery, describe: ['--view'],
    call: ['--input-file', '--input-json', '--input-stdin', '--request-id', '--idempotency-key', '--if-match', '--output', '--frames-stdin', '--websocket', '--ws-protocols', '--ws-max-output-bytes', '--ws-max-message-bytes', '--ws-max-buffered-bytes']
  };
  const allowed = new Set([...common, ...commandFlags[command]]);
  const parsed = new Map();
  const positional = [];
  for (let index = 0; index < values.length; index++) {
    const name = values[index];
    if (!name.startsWith('--')) { positional.push(name); continue; }
    if (!allowed.has(name)) throw new Error(`Unknown ${command} option ${name}.`);
    if (parsed.has(name)) throw new Error(`Duplicate ${name}.`);
    if (['--input-stdin', '--frames-stdin', '--websocket'].includes(name)) { parsed.set(name, true); continue; }
    const value = values[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing ${name} value.`);
    parsed.set(name, value);
  }
  const expectedArguments = ['search', 'describe', 'call'].includes(command) ? 1 : 0;
  if (positional.length !== expectedArguments) throw new Error(`${command} expects ${expectedArguments} positional argument(s).`);
  const option = name => parsed.get(name);
  const options = { signal };
  const timeout = option('--timeout-ms');
  if (timeout !== undefined) {
    const value = Number(timeout);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('--timeout-ms requires a positive integer.');
    options.timeoutMs = value;
  }
  if (command === 'categories') return { ok: true, data: await sdk.categories(options) };
  const filters = {};
  for (const name of ['category', 'provider', 'owner', 'method', 'pathPrefix', 'query', 'limit', 'cursor']) {
    const value = option('--' + (name === 'pathPrefix' ? 'path-prefix' : name));
    if (value !== undefined) filters[name] = value;
  }
  if (command === 'list') return { ok: true, data: await sdk.list(filters, options) };
  const target = positional[0];
  if (!target || target.startsWith('--')) throw new Error(`${command} requires ${command === 'search' ? 'a query' : 'an operation ID'}.`);
  if (command === 'search') return { ok: true, data: await sdk.search(target, filters, options) };
  if (command === 'describe') return { ok: true, data: await sdk.describe(target, { ...options, view: option('--view') ?? 'input' }) };

  const inputFile = option('--input-file');
  const inputJson = option('--input-json');
  const inputStdin = parsed.has('--input-stdin');
  if (Number(inputFile !== undefined) + Number(inputJson !== undefined) + Number(inputStdin) > 1) throw new Error('Choose one input-file, input-json or input-stdin source.');
  const raw = inputFile ? await fs.readFile(inputFile, 'utf8') : inputJson ?? (inputStdin ? await readInput() : '{}');
  let input;
  try { input = JSON.parse(raw); } catch { throw new Error('Operation input must contain valid JSON.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Operation input must be a JSON object.');
  const requestId = option('--request-id');
  const idempotencyKey = option('--idempotency-key');
  const expectedRevision = option('--if-match');
  const outputPath = option('--output');
  const description = await sdk.describe(target, { ...options, view: 'full' });
  const websocket = description.operation.contract.transport === 'websocket';
  if (parsed.has('--websocket') && !websocket) throw new Error('The selected operation does not declare WebSocket transport.');
  const websocketFlags = ['--frames-stdin', '--ws-protocols', '--ws-max-output-bytes', '--ws-max-message-bytes', '--ws-max-buffered-bytes'];
  if (!websocket && websocketFlags.some(name => parsed.has(name))) throw new Error('WebSocket frame options require a WebSocket operation.');
  if (websocket) {
    if (!outputPath) throw new Error('WebSocket calls require --output <frames.jsonl>.');
    if (['body', 'bodyText', 'bodyBytes', 'bodyBase64', 'bodyStream'].some(name => input[name] !== undefined)) throw new Error('WebSocket frames use --frames-stdin instead of an HTTP body.');
    if (inputStdin && parsed.has('--frames-stdin')) throw new Error('Use an input file or input JSON when stdin carries WebSocket frames.');
    const readLimit = name => {
      const raw = option(name); if (raw === undefined) return undefined;
      const value = Number(raw); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} requires a positive integer.`);
      return value;
    };
    let protocols;
    if (option('--ws-protocols') !== undefined) {
      try { protocols = JSON.parse(option('--ws-protocols')); } catch { throw new Error('--ws-protocols requires a JSON array.'); }
    }
    return runManagerWebSocketCommand({
      catalog: { refresh: async () => ({ ...description, operations: [description.operation] }) },
      request: sdk.request,
      openOperation: (id, native) => sdk.openOperation(id, native, { requestId, idempotencyKey, expectedRevision })
    }, target, {
      ...input, path: input.pathParams ?? input.path ?? {}, outputPath,
      inputStream: parsed.has('--frames-stdin') ? inputStream : undefined, signal,
      timeoutMs: options.timeoutMs, protocols,
      maxOutputBytes: readLimit('--ws-max-output-bytes'), maxMessageBytes: readLimit('--ws-max-message-bytes'),
      maxBufferedBytes: readLimit('--ws-max-buffered-bytes'), redact, protectedCredential
    });
  }
  return sdk.call(target, input, { ...options, requestId, idempotencyKey, expectedRevision, ...(outputPath ? { outputPath } : {}) });
}
