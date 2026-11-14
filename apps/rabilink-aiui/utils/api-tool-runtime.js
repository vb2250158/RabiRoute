import { createOperationSdk, encodeOperationBytes, OperationSdkError } from '../../rabi-agent/lib/operation-sdk.mjs';
import { OPERATION_TOOL_DEFINITIONS, operationIsReadOnly } from '../../rabi-agent/lib/operation-tool-definitions.mjs';
import { validateApiRequest } from '../../../packages/rabi-api-contract/request.mjs';
import { fingerprintApiRequest } from '../../../packages/rabi-api-contract/fingerprint.mjs';
import { API_TOOL_LEDGER_LIMIT, validateApiToolRows } from './api-tool-ledger.js';
import { prepareApiHelp, projectApiHelpResult } from './api-help-view.js';
const copy = value => JSON.parse(JSON.stringify(value));
const fail = code => { throw Object.assign(new Error(code), { code }); };
function validateCanonicalArguments(definition, args) {
  const properties = definition.inputSchema.properties;
  function invalid(field, message) {
    throw new OperationSdkError(message, undefined, { errorCode: 'TOOL_ARGUMENTS_INVALID', field,
      repair: `Read ${definition.name} input schema. Accepted fields: ${Object.keys(properties).join(', ')}.` });
  }
  const unknown = Object.keys(args).find(name => !Object.hasOwn(properties, name));
  if (unknown) invalid(unknown, `Unknown ${definition.name} argument ${unknown}.`);
  const missing = (definition.inputSchema.required || []).find(name => args[name] === undefined);
  if (missing) invalid(missing, `${definition.name} requires ${missing}.`);
  for (const [name, value] of Object.entries(args)) {
    const schema = properties[name];
    if (schema.type === 'string' && typeof value !== 'string'
      || schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))
      || schema.type === 'integer' && (!Number.isInteger(value) || schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)
      || schema.enum && !schema.enum.includes(value)) invalid(name, `Invalid ${definition.name} argument ${name}.`);
  }
}

const LEGACY_API_TOOLS = Object.freeze([
  { type: 'function', function: { name: 'rabi_api_help', description: '分页查找当前 RabiPC 接口：默认返回32条简短索引，沿 nextCursor 原样翻页并保持原筛选和目标。指定 operationId 或精确 path 后返回完整合同（默认1条）。调用前先读完整合同；目录不是权限白名单。默认角色来源电脑，targetDeviceId 可选择其他已鉴权电脑。', parameters: { type: 'object', properties: { targetDeviceId: { type: 'string' }, operationId: { type: 'string' }, path: { type: 'string' }, method: { type: 'string' }, cursor: { type: 'string', maxLength: 4096 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'rabi_api_call', description: '调用全部公开 Rabi 接口和未来接口。mode=http 为普通请求，stream 有界读取原始流/SSE，websocket 有界发送 messages 并读取双向消息；流/WS需要已配对手机和对应宿主API。maxBytes/maxMessages/maxMs限制本次观察，不改变接口权限。默认本轮角色来源PC，targetDeviceId可显式选择其他已鉴权PC。带原operationId和版本条件；未知写入只核对原回执，不换键或目标重放。实际结果交回同一模型继续推理。', parameters: { type: 'object', properties: { targetDeviceId: { type: 'string' }, method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }, path: { type: 'string' }, headers: { type: 'object' }, body: {}, bodyBase64: { type: 'string' }, operationId: { type: 'string' }, mode:{type:'string',enum:['http','stream','websocket']},maxBytes:{type:'integer',minimum:1,maximum:65536},maxMessages:{type:'integer',minimum:1,maximum:64},maxMs:{type:'integer',minimum:100,maximum:30000},messages:{type:'array',maxItems:64,items:{oneOf:[{type:'string'},{type:'object',properties:{bodyBase64:{type:'string'}},required:['bodyBase64'],additionalProperties:false}]}},protocols:{type:'array',items:{type:'string'}} }, required: ['method', 'path'], additionalProperties: false } } }
 ]);
export const RABI_API_TOOLS = Object.freeze([
  ...OPERATION_TOOL_DEFINITIONS.filter(item => item.name !== 'rabi_session').map(item => ({ type: 'function', function: {
    name: item.name, description: item.description, parameters: { ...item.inputSchema,
      properties: { ...item.inputSchema.properties, targetDeviceId: { type: 'string' } } }
  } })),
  ...LEGACY_API_TOOLS
]);
export function createApiToolRuntime({ call, storage, sessionId, defaultTargetDeviceId, onResult = () => {} }) {
  let epoch = 0, closed = false, queued = 0, chain = Promise.resolve();
  const publishResult = value => { try { onResult(value); } catch (_) { /* Presentation cannot change the accepted tool result. */ } };
  if (typeof call !== 'function' || !sessionId || !storage?.save || !storage?.load) fail('API_DEPENDENCIES_REQUIRED');
  const clients = new Map();
  function sdkFor(targetDeviceId) {
    const key = targetDeviceId ?? '';
    if (!clients.has(key)) clients.set(key, createOperationSdk({ request: async (method, path, options = {}) => {
      const result = await call({ method, path, headers: options.headers, ...(targetDeviceId ? { targetDeviceId } : {}) });
      const receipt = result?.structuredContent;
      return { statusCode: receipt?.statusCode ?? (receipt?.ok ? 200 : 0), ok: receipt?.ok === true,
        uncertain: receipt?.uncertain, headers: receipt?.headers ?? {}, identity: receipt?.identity,
        body: JSON.stringify(receipt?.data ?? { code: -1, errorCode: receipt?.code ?? 'API_DISCOVERY_UNAVAILABLE' }) };
    } }));
    return clients.get(key);
  }
  async function execute(event, generation) {
    if (closed || epoch !== generation) fail('TOOL_CANCELLED');
    if (!/^[A-Za-z0-9:._-]{1,128}$/.test(event.callId || '')) fail('TOOL_CALL_ID_INVALID');
    const args = typeof event.arguments === 'string' ? JSON.parse(event.arguments) : event.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail('TOOL_ARGUMENTS_INVALID');
    let packet;
    let canonicalMutation = false;
    const targetDeviceId = args.targetDeviceId || defaultTargetDeviceId;
    if (targetDeviceId !== undefined && (typeof targetDeviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(targetDeviceId))) fail('TOOL_TARGET_INVALID');
    const canonical = OPERATION_TOOL_DEFINITIONS.find(item => item.name === event.functionName && item.name !== 'rabi_session');
    if (canonical) {
      const { targetDeviceId: _target, ...inputArgs } = args;
      validateCanonicalArguments(canonical, inputArgs);
      if (event.functionName === 'rabi_call') {
        const unsupported = ['outputPath', 'nativeHeaders'].find(name => inputArgs.input?.[name] !== undefined);
        if (unsupported) throw new OperationSdkError('This mobile transport has no handler for the requested transport option.', undefined,
          { errorCode: 'TOOL_TRANSPORT_OPTION_UNAVAILABLE', field: 'input.' + unsupported,
            repair: unsupported === 'outputPath' ? 'Use the returned resource or a CLI file output consumer.' : 'Use the original native listener connector described by the operation.' });
      }
      const sdk = sdkFor(targetDeviceId);
      if (event.functionName !== 'rabi_call') {
        let data;
        if (event.functionName === 'rabi_categories') data = await sdk.categories();
        else if (event.functionName === 'rabi_list') data = await sdk.list(inputArgs);
        else if (event.functionName === 'rabi_search') { const { query, ...filters } = inputArgs; data = await sdk.search(query, filters); }
        else data = await sdk.describe(inputArgs.operation, { view: inputArgs.view ?? 'input' });
        if (closed || epoch !== generation) fail('TOOL_CANCELLED');
        const result = { structuredContent: { ok: true, statusCode: 200, data } };
        publishResult({ result, summary: '已读取当前 Rabi 接口目录。' });
        return { result };
      }
      const prepared = await sdk.prepare(inputArgs.operation, inputArgs.input ?? {}, {
        requestId: inputArgs.requestId, idempotencyKey: inputArgs.idempotencyKey, expectedRevision: inputArgs.expectedRevision
      });
      if (closed || epoch !== generation) fail('TOOL_CANCELLED');
      const native = prepared.options;
      packet = { method: prepared.method, path: prepared.target, headers: native.headers };
      if (native.body !== undefined) packet.body = JSON.parse(native.body);
      if (native.bodyBytes !== undefined) packet.bodyBase64 = encodeOperationBytes(native.bodyBytes);
      if (native.bodyText !== undefined) packet.bodyBase64 = encodeOperationBytes(new TextEncoder().encode(native.bodyText));
      for (const name of ['mode','maxBytes','maxMessages','maxMs','messages','protocols']) if (native[name] !== undefined) packet[name] = native[name];
      if (prepared.entry.contract.transport === 'websocket') packet.mode = 'websocket';
      if (prepared.entry.contract.transport === 'sse') packet.mode = 'stream';
      canonicalMutation = !operationIsReadOnly(prepared.entry.contract, packet.method) || packet.mode === 'websocket' && packet.messages?.length > 0;
      if (canonicalMutation && event.writeReconciliationRequired) return { mutation: true, uncertain: true, result: { structuredContent: { ok: false, uncertain: true, code: 'WRITE_RECONCILIATION_REQUIRED', operation: inputArgs.operation } } };
      if (!['GET','HEAD','OPTIONS'].includes(packet.method) || canonicalMutation) {
        packet.operationId = inputArgs.requestId ?? inputArgs.idempotencyKey ?? sessionId + ':' + event.callId;
        if (canonicalMutation && !Object.keys(packet.headers).some(name => name.toLowerCase() === 'idempotency-key')) packet.headers['idempotency-key'] = packet.operationId;
      }
    } else if (event.functionName === 'rabi_api_help') {
      const help = prepareApiHelp(args);
      packet = help.request;
      helpView = help.view;
    } else if (event.functionName === 'rabi_api_call') {
      packet = { ...args };
      delete packet.targetDeviceId;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(String(packet.method || 'GET').toUpperCase())) packet.operationId ||= sessionId + ':' + event.callId;
    } else fail('TOOL_NOT_AVAILABLE');
    const {mode='http',maxBytes=65536,maxMessages=16,maxMs=4000,messages=[],protocols=[],...http}=packet;
    if(!['http','stream','websocket'].includes(mode)||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>65536||!Number.isInteger(maxMessages)||maxMessages<1||maxMessages>64||!Number.isInteger(maxMs)||maxMs<100||maxMs>30000||!Array.isArray(messages)||messages.length>64||messages.some(value=>typeof value!=='string'&&(!value||typeof value.bodyBase64!=='string'||Object.keys(value).some(key=>key!=='bodyBase64')))||!Array.isArray(protocols)||protocols.some(value=>typeof value!=='string'))fail('TOOL_STREAM_ARGUMENTS_INVALID');
    if(mode==='websocket'){http.method=String(http.method||'GET').toUpperCase();if(messages.length)http.operationId ||= sessionId+':'+event.callId;if(http.method!=='GET')fail('TOOL_WEBSOCKET_METHOD_INVALID');}
    const { mutation: _mutation, ...request } = validateApiRequest(http);
    if(mode!=='http')Object.assign(request,{mode,maxBytes,maxMessages,maxMs,messages,protocols});
    if (targetDeviceId !== undefined) request.targetDeviceId = targetDeviceId;
    const fingerprint = fingerprintApiRequest(request), rows = await storage.load() || [];
    validateApiToolRows(rows);
    // This is local request identity, not proof of a backend/business result.
    // Keep generated operation IDs available to the model after lost responses.
    const requestIdentity = (row, verified = true) => ({ callId: row.id,
      ...(row.sessionId ? { sessionId: row.sessionId } : {}),
      ...(row.operationId ? { operationId: row.operationId } : {}),
      ...(verified && request.targetDeviceId ? { targetDeviceId: request.targetDeviceId } : {}) });
    const duplicate = row => ({ duplicate: true, resultAvailable: false,
      uncertain: row.state !== 'completed', state: row.state, requestIdentity: requestIdentity(row) });
    const old = rows.find(row => row.id === event.callId && (!row.sessionId || row.sessionId === sessionId));
    if (old) {
      // Identity must survive runtime recreation. Older read rows did not save
      // a fingerprint, so their state cannot attest to this request's outcome.
      if (!old.fingerprint) return { duplicate: true, resultAvailable: false, uncertain: true, state: old.state,
        code: 'TOOL_CALL_FINGERPRINT_UNVERIFIED', requestIdentity: requestIdentity(old, false) };
      if (old.fingerprint !== fingerprint) fail('TOOL_CALL_ID_CONFLICT');
      return duplicate(old);
    }
    const sameOperation = request.operationId && rows.find(row => row.operationId === request.operationId);
    if (sameOperation && sameOperation.fingerprint !== fingerprint) fail('TOOL_OPERATION_TARGET_CONFLICT');
    if (sameOperation) return duplicate(sameOperation);
    // Write history cannot consume the separate read slots needed to query
    // original receipts. Reopening clears read slots, never operation history.
    if (rows.filter(row => Boolean(row.operationId) === Boolean(request.operationId)).length >= API_TOOL_LEDGER_LIMIT) fail('TOOL_LEDGER_FULL');
    const record = { id: event.callId, sessionId, fingerprint, ...(request.operationId ? { operationId: request.operationId } : {}), state: 'pending' };
    await storage.save([...rows, record]);
    if (closed || epoch !== generation) fail('TOOL_CANCELLED');
    let result, callFailed = false;
    try { result = await call(request, { isCurrent: () => !closed && epoch === generation }); }
    catch (error) {
      // The page adapter can prove rejection before the actual API dispatch.
      if (error?.requestDispatched === false) throw error;
      if (!canonical) callFailed = true;
      else return { mutation: canonicalMutation, uncertain: canonicalMutation, result: { structuredContent: {
        ok: false, uncertain: canonicalMutation, operation: args.operation,
        ...(request.operationId ? { requestId: request.operationId } : {}), code: 'API_OUTCOME_UNCONFIRMED'
      } } };
    }
    if (canonical && result) {
      const receipt = result?.structuredContent;
      const error = receipt?.data;
      if (receipt?.statusCode === 404 || receipt?.identityChanged || receipt?.code === 'API_IDENTITY_UNCONFIRMED'
        || error?.errorCode === 'API_CONTRACT_CHANGED' || error?.errorCode === 'API_LISTENER_BINDING_CHANGED') sdkFor(targetDeviceId).invalidate();
      result = { ...result, structuredContent: { ...result?.structuredContent,
        operation: args.operation, ...(request.operationId ? { requestId: request.operationId } : {}) } };
    }
    const identity = requestIdentity(record);
    if (closed || epoch !== generation) return { cancelled: true };
    if (helpView) result = projectApiHelpResult(result, helpView);
    const ok = result?.structuredContent?.ok === true && !result.structuredContent.uncertain && !result.isError;
    // Preserve the original identity even when transport diagnostics or the
    // settlement write fail. Never expose arbitrary exception text to the model.
    const output = { ...(callFailed ? { uncertain: true, code: 'TOOL_OUTCOME_UNCONFIRMED' } : { result }),
      requestIdentity: identity, resultAvailable: !callFailed && result !== undefined,
      ...(canonical ? { mutation: canonicalMutation } : {}) };
    try { await storage.save([...rows, { ...record, state: ok ? 'completed' : 'uncertain' }]); }
    catch (error) {
      if (!canonical) return { ...output, uncertain: true, code: 'TOOL_RECEIPT_SAVE_UNCONFIRMED' };
      return { mutation: canonicalMutation, uncertain: canonicalMutation, result: { ...result, isError: true,
        structuredContent: { ...result.structuredContent, ok: false, uncertain: canonicalMutation,
          code: 'TOOL_RECEIPT_PERSISTENCE_FAILED', localReceiptState: 'unconfirmed' } } };
    }
    if (closed || epoch !== generation) return { cancelled: true };
    if (callFailed) return output;
    publishResult({ result, summary: ok ? 'Rabi 接口已返回，详情可在工具结果查看。' : 'Rabi 接口未确认成功，请查看状态和原回执。' });
    return output;
  }
  return { loadTools: async () => copy(RABI_API_TOOLS),
    handleToolCall(event) {
      if (closed) return Promise.reject(Object.assign(new Error('TOOL_CLOSED'), { code: 'TOOL_CLOSED' }));
      if (event?.isComplete !== true) return Promise.resolve({ ignored: true });
      if (queued >= 16) return Promise.reject(new Error('TOOL_QUEUE_FULL'));
      let captured; try { captured = copy(event); if (JSON.stringify(captured).length > 262144) fail('TOOL_PAYLOAD_LIMIT'); } catch (error) { return Promise.reject(error); }
      queued++; const generation = epoch;
      const result = chain.then(() => execute(captured, generation)).catch(error => {
        if (!(error instanceof OperationSdkError)) throw error;
        if (closed || epoch !== generation) return { cancelled: true };
        const result = { isError: true, structuredContent: { ok: false, uncertain: error.receipt?.uncertain === true,
          ...(error.receipt?.statusCode === undefined ? {} : { statusCode: error.receipt.statusCode }),
          error: error.details ?? { errorCode: error.code, message: error.message } } };
        publishResult({ result, summary: 'Rabi 接口返回了具体错误，请按字段和修复入口继续。' });
        return { result };
      });
      chain = result.catch(() => {});
      return result.finally(() => queued--);
    }, cancelPresentation() { epoch++; for (const sdk of clients.values()) sdk.invalidate(); },
    dispose() { closed = true; epoch++; for (const sdk of clients.values()) sdk.invalidate(); clients.clear(); } };
}
