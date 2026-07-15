import wx from "wx";

const DEFAULT_TIMEOUT_MS = 45000;

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

function requestJson(config, path, options = {}) {
  const baseUrl = trimEndSlash(config.relayBaseUrl);
  const token = String(config.token || "").trim();
  if (!baseUrl) return Promise.reject(new Error("Relay URL is empty."));
  if (!token) return Promise.reject(new Error("RabiLink token is empty."));

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${baseUrl}${path}`,
      method: options.method || "GET",
      data: options.body || undefined,
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      header: {
        "accept": "application/json",
        "content-type": "application/json; charset=utf-8",
        "X-RabiLink-Token": token
      },
      success(response) {
        const statusCode = Number(response.statusCode || 0);
        const data = typeof response.data === "string" ? safeParseJson(response.data) : (response.data || {});
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(data.message || `HTTP ${statusCode}`));
          return;
        }
        if (data && data.ok === false && data.code !== 0) {
          reject(new Error(data.message || data.error || "RabiLink request failed."));
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
  return requestJson(config, `/api/rabilink/mobile/routes${targetQuery(targetDeviceId)}`);
}

export function getMobileAgentOptions(config, routeId, targetDeviceId = "") {
  return requestJson(
    config,
    `/api/rabilink/mobile/routes/${encodePath(routeId)}/agent-options${targetQuery(targetDeviceId)}`
  );
}

export function setMobileAgentBinding(config, routeId, binding, targetDeviceId = "") {
  return requestJson(
    config,
    `/api/rabilink/mobile/routes/${encodePath(routeId)}/agent-binding${targetQuery(targetDeviceId)}`,
    {
      method: "PATCH",
      body: binding
    }
  );
}

export function getMobileWebgui(config, path, targetDeviceId = "") {
  const query = new URLSearchParams({ path });
  const target = String(targetDeviceId || "").trim();
  if (target) query.set("targetDeviceId", target);
  return requestJson(config, `/api/rabilink/mobile/webgui?${query.toString()}`);
}

export function postMobileWebgui(config, path, body = {}, targetDeviceId = "", method = "POST") {
  return requestJson(
    config,
    `/api/rabilink/mobile/webgui${targetQuery(targetDeviceId)}`,
    {
      method: "POST",
      body: {
        method,
        path,
        body
      }
    }
  );
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
