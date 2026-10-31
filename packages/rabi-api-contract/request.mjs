// Public Manager request contract shared by Relay and QuickJS clients.
export const API_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
export const API_HEADERS = Object.freeze(['accept', 'content-type', 'range', 'if-range', 'if-match', 'idempotency-key', 'x-rabiroute-expected-application-generation-id', 'x-rabiroute-expected-manager-instance-id']);
// Public API extensions may introduce new contract headers without a device update.
// Authentication, proxy identity and HTTP framing remain transport-owned.
const PRIVATE_HEADERS = new Set(['authorization', 'proxy-authorization', 'proxy-authenticate', 'cookie', 'cookie2', 'set-cookie', 'host', 'origin', 'referer', 'connection', 'upgrade', 'transfer-encoding', 'content-length', 'keep-alive', 'te', 'trailer', 'forwarded', 'x-rabiroute-relay-proxy', 'x-rabiroute-peer-proxy', 'x-rabiroute-agent-id', 'x-rabiroute-node-id', 'x-rabiroute-route-id', 'x-rabiroute-persona-messaging-capability', 'x-rabiroute-webgui-token', 'x-rabiroute-host-token', 'x-remote-agent-token']);
export function apiRequestHeaderAllowed(name) {
  const key = String(name).toLowerCase();
  return /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key) && !PRIVATE_HEADERS.has(key) && !key.startsWith('x-forwarded-') && !key.startsWith('x-rabilink-');
}
const fail = code => { throw Object.assign(new Error(code), { code }); };
export function validateApiRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['method', 'path', 'headers', 'body', 'bodyBase64', 'operationId'].includes(key))) fail('API_REQUEST_INVALID');
  const method = String(value.method || 'GET').toUpperCase();
  if (!API_METHODS.includes(method)) fail('API_METHOD_INVALID');
  const path = value.path;
  if (typeof path !== 'string' || path.length > 8192 || !path.startsWith('/') || path.startsWith('//') || /[\\#\r\n\0]/.test(path)) fail('API_PATH_INVALID');
  let decoded = path.split('?')[0];
  for (let depth = 0; depth < 8; depth++) {
    let next; try { next = decodeURIComponent(decoded); } catch { fail('API_PATH_INVALID'); }
    if (next.split('/').some(part => part === '.' || part === '..') || /[\\\r\n\0]/.test(next) || next.startsWith('//')) fail('API_PATH_INVALID');
    if (next === decoded) break;
    decoded = next;
    if (depth === 7) fail('API_PATH_INVALID');
  }
  if (decoded.startsWith('/__rabilink/') || decoded.startsWith('/api/internal/')) fail('API_PRIVATE_PATH');
  const headers = {};
  if (value.headers !== undefined && (!value.headers || typeof value.headers !== 'object' || Array.isArray(value.headers))) fail('API_HEADERS_INVALID');
  for (const [name, content] of Object.entries(value.headers || {})) {
    const key = name.toLowerCase();
    if (!apiRequestHeaderAllowed(key) || typeof content !== 'string' || content.length > 512 || /[\r\n\0]/.test(content)) fail('API_HEADERS_INVALID');
    headers[key] = content;
  }
  if (value.body !== undefined && value.bodyBase64 !== undefined) fail('API_BODY_INVALID');
  if (value.bodyBase64 !== undefined && (typeof value.bodyBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bodyBase64))) fail('API_BODY_INVALID');
  if (JSON.stringify(value).length > 262144) fail('API_BODY_LIMIT');
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (mutation && (typeof value.operationId !== 'string' || !/^[A-Za-z0-9:._-]{1,128}$/.test(value.operationId))) fail('API_OPERATION_ID_REQUIRED');
  if (mutation && !headers['idempotency-key']) headers['idempotency-key'] = value.operationId;
  return { method, path, headers, ...(value.body === undefined ? {} : { body: value.body }), ...(value.bodyBase64 === undefined ? {} : { bodyBase64: value.bodyBase64 }), ...(value.operationId === undefined ? {} : { operationId: value.operationId }), mutation };
}

/** Resource timing only; connection authorization and API availability are unchanged. */
export function apiRequestTimingPolicy(request, { defaultBudgetMs = 3000 } = {}) {
  if (String(request?.method || 'GET').toUpperCase() !== 'GET' || typeof request?.path !== 'string') return undefined;
  const separator = request.path.indexOf('?');
  const pathname = separator < 0 ? request.path : request.path.slice(0, separator);
  if (!/^\/api\/roles\/[^/]+\/message-endpoint-history$/.test(pathname)) return undefined;
  let budgetMs = Number.isInteger(defaultBudgetMs) && defaultBudgetMs >= 1 && defaultBudgetMs <= 2147483647 ? defaultBudgetMs : 3000, budgetParameterValid = true;
  if (separator >= 0) {
    for (const parameter of request.path.slice(separator + 1).split('&')) {
      const equals = parameter.indexOf('=');
      let name, value;
      try {
        name = decodeURIComponent((equals < 0 ? parameter : parameter.slice(0, equals)).replace(/\+/g, ' '));
      } catch { continue; }
      if (name !== 'budgetMs') continue;
      try { value = decodeURIComponent((equals < 0 ? '' : parameter.slice(equals + 1)).replace(/\+/g, ' ')); }
      catch { budgetParameterValid = false; break; }
      // Invalid values remain the Manager's 400 response; they never extend transport time.
      if (/^[1-9][0-9]*$/.test(value) && Number(value) <= 2147483647) budgetMs = Number(value);
      else budgetParameterValid = false;
      break;
    }
  }
  return { budgetMs, budgetParameterValid, maxAttempts: 1, pathTemplate: '/api/roles/:roleId/message-endpoint-history' };
}

/** Diagnostics may identify the operation without copying role IDs or query parameters. */
export function apiRequestDiagnosticPath(request) {
  return apiRequestTimingPolicy(request)?.pathTemplate ?? (typeof request?.path === 'string' ? request.path : '');
}
