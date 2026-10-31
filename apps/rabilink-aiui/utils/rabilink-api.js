import { adoptTimeoutSettings, requestTimeout, configureTimeoutStorage } from "./timeout-settings.js";
import wx from "wx";
import { fingerprintApiRequest } from '../../../packages/rabi-api-contract/fingerprint.mjs';
import { phoneEyeHttpRequest, phoneEyeStreamRequest, phoneEyeOpenWebSocket } from './phone-eye-transport.js';

configureTimeoutStorage(wx);
const DEFAULT_TIMEOUT_MS = 45000;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9:._-]{1,256}$/;
const MUTATION_HEADER_NAMES = Object.freeze({
  operationId: "Idempotency-Key",
  expectedContentHash: "If-Match"
});

function trimEndSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function encodePath(value) {
  return encodeURIComponent(String(value || ""));
}

function mutationHeaders(mutation) {
  if (!mutation) return {};
  const operationId = String(mutation.operationId || "").trim();
  const expectedContentHash = String(mutation.expectedContentHash || "").trim().toLowerCase();
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error("Route mutation requires a caller-owned stable operationId.");
  }
  if (!CONTENT_HASH_PATTERN.test(expectedContentHash)) {
    throw new Error("Route mutation requires the current strong route catalog content hash.");
  }
  return {
    [MUTATION_HEADER_NAMES.operationId]: operationId,
    [MUTATION_HEADER_NAMES.expectedContentHash]: expectedContentHash
  };
}

function allowedResponseHeaders(response = {}) {
  const source = response.header || response.headers || {};
  const allowed = {};
  for (const [name, value] of Object.entries(source)) {
    const normalized = String(name || "").trim().toLowerCase();
    if (!["idempotency-key", "if-match", "etag", "x-rabiroute-operation-id", "x-rabiroute-content-hash"].includes(normalized)) continue;
    allowed[normalized] = String(value || "").trim();
  }
  return allowed;
}

function withResponseMetadata(data, response) {
  if (!data || typeof data !== "object") return data;
  data.mutationHeaders = allowedResponseHeaders(response);
  return data;
}

function routeCatalogResult(json) {
  const data = json && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : {};
  const routes = Array.isArray(data.routes) ? data.routes : (Array.isArray(json?.routes) ? json.routes : []);
  const routeCatalog = json?.routeCatalog && typeof json.routeCatalog === "object"
    ? json.routeCatalog
    : (data.routeCatalog && typeof data.routeCatalog === "object" ? data.routeCatalog : {});
  return {
    routes,
    routeCatalog,
    contentHash: String(routeCatalog.contentHash || "").trim().toLowerCase(),
    routeConfigHash: String(routeCatalog.routeConfigHash || routeCatalog.contentHash || "").trim().toLowerCase(),
    rawJson: json
  };
}

function requireCommittedMutationReceipt(json, mutation) {
  const receipt = json?.mutationReceipt || json?.receipt || json?.data?.receipt;
  const operationId = String(receipt?.operationId || "").trim();
  const state = String(receipt?.state || receipt?.status || "").trim().toLowerCase();
  const contentHash = String(
    receipt?.routeConfigHash
      || receipt?.contentHash
      || json?.routeCatalog?.routeConfigHash
      || json?.routeCatalog?.contentHash
      || ""
  ).trim().toLowerCase();
  if (!receipt || operationId !== mutation.operationId || state !== "committed" || !CONTENT_HASH_PATTERN.test(contentHash)) {
    const error = new Error("Route mutation response is missing a matching explicit committed receipt.");
    error.code = "route_mutation_receipt_invalid";
    throw error;
  }
  return {
    ...json,
    mutationReceipt: {
      ...receipt,
      operationId,
      state: "committed",
      contentHash
    }
  };
}

function requestJson(config, path, options = {}) {
  const baseUrl = trimEndSlash(config.relayBaseUrl);
  const token = String(config.token || "").trim();
  if (!baseUrl) return Promise.reject(new Error("Relay URL is empty."));
  if (options.auth !== false && !token) return Promise.reject(new Error("RabiLink token is empty."));

  const header = {
    "accept": "application/json",
    "content-type": "application/json; charset=utf-8"
  };
  if (options.auth !== false) header["X-RabiLink-Token"] = token;
  header["X-Rabi-Timeout-Ms"] = String(requestTimeout(config, options.targetDeviceId || options.body?.targetDeviceId, "aiui.http.request", options.timeoutMs || DEFAULT_TIMEOUT_MS));
  Object.assign(header, mutationHeaders(options.mutation));

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${baseUrl}${path}`,
      method: options.method || "GET",
      data: options.body || undefined,
      timeout: requestTimeout(config, options.targetDeviceId || options.body?.targetDeviceId, "aiui.http.request", options.timeoutMs || DEFAULT_TIMEOUT_MS),
      header,
      success(response) {
        const statusCode = Number(response.statusCode || 0);
        const data = withResponseMetadata(
          typeof response.data === "string" ? safeParseJson(response.data) : (response.data || {}),
          response
        );
        if (statusCode < 200 || statusCode >= 300) {
          const error = new Error(data.message || `HTTP ${statusCode}`);
          error.statusCode = statusCode;
          error.code = data.code;
          error.response = data;
          error.mutationHeaders = data.mutationHeaders || {};
          reject(error);
          return;
        }
        if (data && data.ok === false && data.code !== 0) {
          const error = new Error(data.message || data.error || "RabiLink request failed.");
          error.statusCode = statusCode;
          error.code = data.code;
          error.response = data;
          error.mutationHeaders = data.mutationHeaders || {};
          reject(error);
          return;
        }
        resolve(data);
      },
      fail(error) {
        reject(new Error(error.errMsg || "Network request failed."));
      }
    });
  });
}

function safeParseJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    return { code: -1, message: text };
  }
}

// QuickJS provides buffered HTTP only. The Relay facade transports an arbitrary
// Manager request; it never selects a persona or implements a Manager operation.
export const AIUI_HTTP_TRANSPORT_CAPABILITIES = Object.freeze({ transport: 'relay', bufferedHttp: true, lan: false, p2p: false, streaming: false, websocket: false });

function beginHttpOperation(path, body) {
  const key = 'rabilink-aiui-http-operations-v1';
  const previous = wx.getStorageSync(key) || { seed: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2), counter: 0, rows: [] };
  if (!Number.isSafeInteger(previous.counter) || previous.counter < 0 || previous.counter >= Number.MAX_SAFE_INTEGER || !Array.isArray(previous.rows) || previous.rows.length >= 128) throw new Error('HTTP_OPERATION_STORAGE_LIMIT');
  const counter = previous.counter + 1, operationId = 'aiui-http:' + previous.seed + ':' + counter;
  // Retain original write intent before dispatch. Unknown results are never replayed automatically.
  wx.setStorageSync(key, { ...previous, counter, rows: [...previous.rows, { operationId, requestHash: fingerprintApiRequest({ path, body }), state: 'pending' }] });
  return operationId;
}

function settleHttpOperation(operationId) {
  if (!operationId?.startsWith('aiui-http:')) return;
  const key = 'rabilink-aiui-http-operations-v1', state = wx.getStorageSync(key);
  if (state?.rows) wx.setStorageSync(key, { ...state, rows: state.rows.filter(row => row.operationId !== operationId) });
}

export async function requestManagerJson(config, path, options = {}) {
  const targetDeviceId = String(options.targetDeviceId || config.targetDeviceId || '').trim();
  const headers = { ...mutationHeaders(options.mutation), ...options.headers };
  const method = options.method || 'GET';
  const operationId = options.operationId || options.mutation?.operationId || (!['GET', 'HEAD', 'OPTIONS'].includes(method) ? beginHttpOperation(path, options.body) : undefined);
  const result = await requestDeviceApi(config, { targetDeviceId, request: {
    method, path, headers,
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(operationId ? { operationId } : {})
  } });
  const receipt = result.structuredContent;
  if (!receipt || receipt.ok !== true || receipt.uncertain === true) {
    const error = new Error(receipt?.code || 'MANAGER_REQUEST_UNCONFIRMED');
    error.code = receipt?.code; error.statusCode = receipt?.statusCode; error.uncertain = receipt?.uncertain === true; error.response = receipt;
    throw error;
  }
  settleHttpOperation(operationId);
  if (receipt.data?.ok === false || (receipt.data?.code !== undefined && receipt.data.code !== 0)) {
    const error = new Error(receipt.data.message || String(receipt.data.code || 'MANAGER_BUSINESS_FAILED'));
    error.code = receipt.data.code; error.statusCode = receipt.statusCode; error.response = receipt.data;
    throw error;
  }
  return withResponseMetadata(receipt.data, { headers: receipt.headers });
}

async function deviceProfileOwner(config) {
  const roster = await requestJson(config, '/api/rabilink/devices/connections', { timeoutMs: 12000 });
  const devices = roster?.data?.devices;
  if (roster.code !== 0 || !Array.isArray(devices) || devices.length !== 1 || !devices[0].connectionTargetDeviceId) throw new Error('DEVICE_PROFILE_OWNER_UNAVAILABLE');
  return devices[0].connectionTargetDeviceId;
}

export async function getDeviceAgentProfile(config) {
  const owner = await deviceProfileOwner(config);
  return requestManagerJson(config, "/api/rabilink/agent-devices/self/profile", { targetDeviceId: owner, timeoutMs: 12000 }).then(result => {
    if (result?.code !== 0 || !result.data || typeof result.data !== "object") throw new Error("Invalid device profile response");
    adoptTimeoutSettings(config, owner, result.data.timeoutOverrides);
    return result.data;
  });
}

export async function requestDeviceApi(config, packet) {
  const targetDeviceId = String(packet.targetDeviceId || config.targetDeviceId || '').trim();
  const edge=await phoneEyeHttpRequest(config,{targetDeviceId,request:packet.request});
  if(edge){if(!edge.structuredContent)throw new Error('PHONE_BRIDGE_RESPONSE_INVALID');return edge;}
  return requestJson(config, '/api/rabilink/device/api', { method: 'POST', body: { targetDeviceId, request: packet.request }, timeoutMs: 30000 }).then(result => {
    if (result?.code !== 0 || !result.data?.structuredContent) throw new Error('API_RESPONSE_INVALID');
    return { ...result.data, transportCapabilities: AIUI_HTTP_TRANSPORT_CAPABILITIES };
  });
}

export function recordAiuiConversation(config, packet) {
  const ref = packet.personaRef;
  if (!ref?.roleId || !ref.sourceDeviceId) return Promise.reject(new Error('AIUI_HISTORY_PERSONA_REQUIRED'));
  return requestManagerJson(config, '/api/roles/' + encodePath(ref.roleId) + '/chat-history/aiui', {
    targetDeviceId: ref.sourceDeviceId, method: 'POST', body: { sessionId: packet.sessionId, turnId: packet.turnId, userText: packet.userText, ...(packet.assistantText ? { assistantText: packet.assistantText } : {}) },
    operationId: 'aiui-history:' + packet.sessionId + ':' + packet.turnId + ':' + (packet.assistantText ? 'reply' : 'user'), timeoutMs: 30000
  }).then(result => {
    const receipt = result?.data?.receipt;
    if (result?.code !== 0 || receipt?.state !== 'committed' || receipt.turnId !== packet.turnId) throw new Error('AIUI_HISTORY_UNCONFIRMED');
    return { ...receipt, roleId: ref.roleId, sourceDeviceId: ref.sourceDeviceId };
  });
}

export async function reportDeviceAgentProfileApplied(config, body) {
  const owner = await deviceProfileOwner(config);
  return requestManagerJson(config, "/api/rabilink/agent-devices/self/profile/receipt", { targetDeviceId: owner, method: "POST", body, operationId: body.idempotencyKey, timeoutMs: 12000 }).then(result => {
    if (result?.code !== 0 || !result.data || typeof result.data !== "object") throw new Error("Device profile receipt not confirmed");
    return result.data;
  });
}

export function getMobileState(config, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return requestJson(config, "/api/rabilink/mobile/state", { timeoutMs });
}
export function requestManagerStream(config,packet,observer){return phoneEyeStreamRequest(config,packet,observer);}
export function openManagerWebSocket(config,packet){return phoneEyeOpenWebSocket(config,packet);}

export async function getMobileDeviceStatus(config, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const directory = await getMobileState(config, timeoutMs);
  const owner = String(directory.connectionOwnerDeviceId || '').trim();
  if (!owner) throw new Error('MOBILE_OWNER_PC_NOT_CONFIGURED');
  return requestManagerJson(config, "/api/rabilink/mobile/device-status", { targetDeviceId: owner, timeoutMs });
}

export async function getDeviceAgentContext(config) {
  const directory=await requestJson(config,'/api/rabilink/devices/connections');
  const devices=directory?.data?.devices || [];
  if(devices.length!==1 || !devices[0].id || !devices[0].connectionTargetDeviceId)throw new Error('DEVICE_AGENT_CONNECTION_REQUIRED');
  return {agentId:devices[0].id,targetDeviceId:devices[0].connectionTargetDeviceId};
}
export async function requestDeviceAgent(config,context,suffix,{method='GET',body,operationId}={}) {
  const response=await requestManagerJson(config,'/api/device-agents/'+encodePath(context.agentId)+suffix,{targetDeviceId:context.targetDeviceId,method,body,operationId,timeoutMs:30000});
  if(response?.code!==0 || !response.data)throw new Error(response?.code || 'DEVICE_AGENT_UNCONFIRMED');
  return response.data;
}

export function selectMobileTarget(config, targetDeviceId) {
  return requestJson(config, "/api/rabilink/mobile/target", {
    method: "PATCH",
    body: { targetDeviceId }
  });
}

async function managerRoutePath(config, targetDeviceId, suffix = '') {
  const state = await getMobileState(config);
  const target = String(targetDeviceId || config.targetDeviceId || state.selectedTargetDeviceId || '').trim();
  const worker = (state.workers || []).find(row => (row.id || row.guid) === target);
  if (!worker) throw new Error('ROUTE_TARGET_NOT_CONNECTED');
  return { targetDeviceId: worker.id || worker.guid, path: '/api/rabi/instances/' + encodePath(worker.guid || worker.id) + '/routes' + suffix };
}

export async function getMobileRoutes(config, targetDeviceId = "") {
  const target = await managerRoutePath(config, targetDeviceId, '?includeProfiles=true&presentation=mobile');
  return requestManagerJson(config, target.path, { targetDeviceId: target.targetDeviceId })
    .then(routeCatalogResult);
}

export async function getMobileAgentOptions(config, routeId, targetDeviceId = "") {
  const target = await managerRoutePath(config, targetDeviceId, '/' + encodePath(routeId) + '/agent-options');
  return requestManagerJson(
    config,
    target.path, { targetDeviceId: target.targetDeviceId }
  );
}

export async function setMobileAgentBinding(config, routeId, binding, mutation, targetDeviceId = "") {
  mutationHeaders(mutation);
  const target = await managerRoutePath(config, targetDeviceId, '/' + encodePath(routeId) + '/agent-binding');
  return requestManagerJson(
    config,
    target.path,
    {
      method: "PATCH",
      body: binding,
      mutation, targetDeviceId: target.targetDeviceId
    }
  ).then((json) => requireCommittedMutationReceipt(json, mutation));
}

export function getMobileWebgui(config, path, targetDeviceId = "") {
  return requestManagerJson(config, path, { targetDeviceId });
}

export function postMobileWebgui(config, path, body = {}, targetDeviceId = "", method = "POST", mutation = null) {
  const headers = mutationHeaders(mutation);
  return requestManagerJson(
    config,
    path,
    {
      method, body, headers, mutation, targetDeviceId
    }
  ).then((json) => mutation ? requireCommittedMutationReceipt(json, mutation) : json);
}

export async function sendMobileProof(config, proof = {}) {
  const directory = await getMobileState(config, 8000);
  const owner = String(directory.connectionOwnerDeviceId || '').trim();
  if (!owner) throw new Error('APPLICATION_CONNECTION_OWNER_REQUIRED');
  return requestManagerJson(config, "/api/rabilink/mobile/proof", {
    method: "POST", body: proof, targetDeviceId: owner,
    operationId: 'aiui-proof:' + String(proof.sessionId || '') + ':' + String(proof.event || '') + ':' + String(proof.time || Date.now()),
    timeoutMs: 8000
  });
}





export function claimRabiLinkDeviceToken(config, serialNumber) {
  const normalizedSerial = String(serialNumber || "").trim();
  if (!normalizedSerial) return Promise.reject(new Error("Device serial number is empty."));
  return requestJson(config, "/api/rabilink/devices/token", {
    auth: false,
    method: "POST",
    body: { serialNumber: normalizedSerial },
    timeoutMs: 8000
  });
}

export function publishRabiLinkDeviceLogs(config, payload = {}) {
  const logs = Array.isArray(payload.logs) ? payload.logs.slice(0, 20) : [];
  if (!logs.length) return Promise.resolve({ code: 0, ok: true, accepted: 0 });
  return requestJson(config, "/api/rabilink/devices/logs", {
    method: "POST",
    body: {
      deviceId: String(payload.deviceId || "unidentified-glasses"),
      deviceKind: String(payload.deviceKind || "glasses"),
      deviceName: String(payload.deviceName || "Rokid Glass"),
      source: String(payload.source || "rabilink-aiui"),
      appVersion: String(payload.appVersion || ""),
      sessionId: String(payload.sessionId || ""),
      mode: String(payload.mode || ""),
      logs
    },
    timeoutMs: 8000
  });
}
