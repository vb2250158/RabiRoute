const string = { type: 'string' };
const object = properties => ({ type: 'object', properties, additionalProperties: false });
const filters = { category: string, query: string, provider: string, owner: string, method: string, pathPrefix: string,
  limit: { type: 'integer', minimum: 1, maximum: 200 }, cursor: string };
export const OPERATION_TOOL_DEFINITIONS = Object.freeze([
  { name: 'rabi_categories', readOnly: true, description: 'List Rabi business categories and plugin-defined categories from the current running catalog.', inputSchema: object({}) },
  { name: 'rabi_list', readOnly: true, description: 'List short operation summaries by category or provider. Follow nextCursor; use describe for input parameters.', inputSchema: object(filters) },
  { name: 'rabi_search', readOnly: true, description: 'Search available Rabi operations by Chinese or English intent, category, provider or operation ID. Returns short summaries and describe links.', inputSchema: { ...object(filters), required: ['query'] } },
  { name: 'rabi_describe', readOnly: true, description: 'Read one operation input, result or full contract, including parameter sources and related operations.', inputSchema: { ...object({ operation: string, view: { enum: ['input', 'result', 'full'] } }), required: ['operation'] } },
  { name: 'rabi_call', readOnly: false, description: 'Invoke any current public Rabi operation through the same SDK as CLI. operation identifies the capability; requestId/idempotencyKey identify this request. Preserve original receipts and uncertainty.', inputSchema: { ...object({ operation: string,
    input: { type: 'object', description: 'Operation input from describe: pathParams, query, body, headers and documented native transport options.' },
    requestId: string, idempotencyKey: string, expectedRevision: string }), required: ['operation'] } },
  { name: 'rabi_session', readOnly: false, description: 'Read, send to, or close the original stream/WebSocket session returned by rabi_call. Reads never replay the original business request.', inputSchema: { ...object({ sessionId: string, action: { enum: ['read', 'send', 'close'] }, text: string, base64: string, json: {} }), required: ['sessionId', 'action'] } }
]);

export { operationIsReadOnly } from './api-operation-effects.mjs';
