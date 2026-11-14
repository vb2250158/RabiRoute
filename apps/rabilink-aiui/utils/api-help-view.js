// The Manager owns filtering, snapshot cursors and complete API contracts.
// This client projection keeps discovery schemas out of the model's index view.
const fail = () => { throw Object.assign(new Error('TOOL_ARGUMENTS_INVALID'), { code: 'TOOL_ARGUMENTS_INVALID' }); };
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export function prepareApiHelp(args) {
  const strings = { targetDeviceId: 128, operationId: 4096, path: 4096, method: 64, cursor: 4096 };
  for (const [key, value] of Object.entries(args)) {
    if (key === 'limit') {
      if (!Number.isInteger(value) || value < 1 || value > 200) fail();
    } else if (!has(strings, key) || typeof value !== 'string' || !value.trim() || value.length > strings[key]) fail();
  }
  const view = args.operationId || args.path ? 'contract' : 'index';
  const query = ['operationId', 'path', 'method', 'cursor']
    .filter(key => args[key] !== undefined).map(key => encodeURIComponent(key) + '=' + encodeURIComponent(args[key]));
  query.push('limit=' + (args.limit ?? (view === 'index' ? 32 : 1)));
  return { view, request: { method: 'GET', path: '/api/agent/help?' + query.join('&') } };
}

export function projectApiHelpResult(result, view) {
  const receipt = result?.structuredContent, body = receipt?.data, catalog = body?.data;
  // Preserve errors, unknown outcomes and older/foreign response formats as-is.
  if (view !== 'index' || receipt?.ok !== true || receipt.uncertain || result.isError
      || body?.code !== 0 || catalog?.schemaVersion !== '2' || !Array.isArray(catalog.operations)) return result;
  const data = {};
  for (const key of ['schemaVersion', 'applicationGenerationId', 'managerInstanceId', 'pluginGenerationId',
    'catalogRevision', 'catalogDigest', 'count', 'total', 'nextCursor', 'refreshRule', 'errorRule']) {
    if (has(catalog, key)) data[key] = catalog[key];
  }
  data.operations = catalog.operations.map(operation => {
    const entry = {};
    for (const key of ['id', 'method', 'pathTemplate', 'description', 'contractVersion', 'contractDigest']) {
      if (has(operation, key)) entry[key] = operation[key];
    }
    if (operation.contract?.transport) entry.transport = operation.contract.transport;
    if (operation.contract?.effects?.mode) entry.effectsMode = operation.contract.effects.mode;
    return entry;
  });
  return { ...result, structuredContent: { ...receipt, data: { ...body, data } },
    // A transport may carry a second textual copy of the full response.
    ...(result.content ? { content: [{ type: 'text', text: 'API discovery index is in structuredContent.data; read an exact operationId for its complete contract.' }] } : {}),
    apiHelpView: 'index', completeContracts: false };
}
