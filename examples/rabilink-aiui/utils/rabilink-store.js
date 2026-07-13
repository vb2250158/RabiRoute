import wx from "wx";

const STORAGE_KEY = "rabilink-aiui-settings";
const TRANSCRIPT_QUEUE_KEY = "rabilink-aiui-transcript-queue";
const MAX_TRANSCRIPT_QUEUE_LENGTH = 100;

export function loadSettings(defaults = {}) {
  const cached = readStorage();
  return {
    relayBaseUrl: cached.relayBaseUrl || defaults.relayBaseUrl || "",
    token: cached.token || defaults.token || "",
    targetDeviceId: cached.targetDeviceId || "",
    selectedRouteId: cached.selectedRouteId || "",
    agentCursor: cached.agentCursor || "",
    agentCursorTokenKey: cached.agentCursorTokenKey || ""
  };
}

export function saveSettings(patch) {
  const next = {
    ...readStorage(),
    ...(patch || {})
  };
  wx.setStorageSync(STORAGE_KEY, next);
  return next;
}

export function maskToken(token) {
  const text = String(token || "").trim();
  if (!text) return "未设置";
  if (text.length <= 10) return "已设置";
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

export function loadTranscriptQueue() {
  try {
    const value = wx.getStorageSync(TRANSCRIPT_QUEUE_KEY);
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => item && typeof item === "object" && String(item.text || "").trim())
      .slice(-MAX_TRANSCRIPT_QUEUE_LENGTH);
  } catch (error) {
    return [];
  }
}

export function saveTranscriptQueue(queue) {
  const next = Array.isArray(queue)
    ? queue
      .filter((item) => item && typeof item === "object" && String(item.text || "").trim())
      .slice(-MAX_TRANSCRIPT_QUEUE_LENGTH)
    : [];
  wx.setStorageSync(TRANSCRIPT_QUEUE_KEY, next);
  return next;
}

function readStorage() {
  try {
    return wx.getStorageSync(STORAGE_KEY) || {};
  } catch (error) {
    return {};
  }
}
