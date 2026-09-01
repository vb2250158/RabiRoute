import wx from "wx";

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

function targetQuery(targetDeviceId) {
  const target = String(targetDeviceId || "").trim();
  return target ? `?targetDeviceId=${encodeURIComponent(target)}` : "";
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
  Object.assign(header, mutationHeaders(options.mutation));

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${baseUrl}${path}`,
      method: options.method || "GET",
      data: options.body || undefined,
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
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

export function getMobileState(config, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return requestJson(config, "/api/rabilink/mobile/state", { timeoutMs });
}

export function selectMobileTarget(config, targetDeviceId) {
  return requestJson(config, "/api/rabilink/mobile/target", {
    method: "PATCH",
    body: { targetDeviceId }
  });
}

export function getMobileRoutes(config, targetDeviceId = "") {
  return requestJson(config, `/api/rabilink/mobile/routes${targetQuery(targetDeviceId)}`)
    .then(routeCatalogResult);
}

export function getMobileAgentOptions(config, routeId, targetDeviceId = "") {
  return requestJson(
    config,
    `/api/rabilink/mobile/routes/${encodePath(routeId)}/agent-options${targetQuery(targetDeviceId)}`
  );
}

export function setMobileAgentBinding(config, routeId, binding, mutation, targetDeviceId = "") {
  return requestJson(
    config,
    `/api/rabilink/mobile/routes/${encodePath(routeId)}/agent-binding${targetQuery(targetDeviceId)}`,
    {
      method: "PATCH",
      body: binding,
      mutation
    }
  ).then((json) => requireCommittedMutationReceipt(json, mutation));
}

export function getMobileWebgui(config, path, targetDeviceId = "") {
  const query = new URLSearchParams({ path });
  const target = String(targetDeviceId || "").trim();
  if (target) query.set("targetDeviceId", target);
  return requestJson(config, `/api/rabilink/mobile/webgui?${query.toString()}`);
}

export function postMobileWebgui(config, path, body = {}, targetDeviceId = "", method = "POST", mutation = null) {
  const headers = mutationHeaders(mutation);
  return requestJson(
    config,
    `/api/rabilink/mobile/webgui${targetQuery(targetDeviceId)}`,
    {
      method: "POST",
      body: {
        method,
        path,
        body,
        ...(mutation ? { headers } : {})
      },
      mutation
    }
  ).then((json) => mutation ? requireCommittedMutationReceipt(json, mutation) : json);
}

export function sendMobileProof(config, proof = {}) {
  return requestJson(config, "/api/rabilink/mobile/proof", {
    method: "POST",
    body: proof,
    timeoutMs: 8000
  });
}

export function publishRabiLinkVoiceInput(config, segment = {}) {
  const text = String(segment.text || "").trim();
  if (!text) return Promise.reject(new Error("Transcript text is empty."));
  return requestJson(config, "/rokid/rabilink/input", {
    method: "POST",
    body: {
      text,
      type: "rabilink.observation",
      deliveryMode: "observe",
      source: "rabilink-aiui",
      sender: "Rokid Glass",
      clientMessageId: String(segment.id || ""),
      sessionId: String(segment.sessionId || ""),
      sequence: Number(segment.sequence || 0),
      capturedAt: Number(segment.createdAt || Date.now())
    }
  });
}

export function requestRabiLinkConversationReview(config, request = {}) {
  const requestedAt = Number(request.requestedAt || Date.now());
  const clientMessageId = String(request.id || `review-${requestedAt}`);
  return requestJson(config, "/rokid/rabilink/input", {
    method: "POST",
    body: {
      text: "用户在眼镜连接会话模式单击触摸板，要求现在审阅会话记录。",
      type: "rabilink.review_request",
      deliveryMode: "observe",
      reviewRequested: true,
      source: "rabilink-aiui-touchpad",
      sender: "Rokid Glass",
      clientMessageId,
      sessionId: String(request.sessionId || ""),
      capturedAt: requestedAt
    }
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

export function getRabiLinkMessageStream(config, after = "", waitMs = 25000) {
  const query = new URLSearchParams();
  query.set("after", String(after || "").trim());
  query.set("stream", "1");
  const boundedWaitMs = Math.max(0, Math.min(60000, Number(waitMs || 0)));
  query.set("waitMs", String(boundedWaitMs));
  return requestJson(config, `/rokid/rabilink/messages?${query.toString()}`, {
    timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, boundedWaitMs + 5000)
  });
}
