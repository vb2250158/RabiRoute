import wx from "wx";

const STORAGE_KEY = "rabilink-aiui-settings";
const TRANSCRIPT_QUEUE_KEY = "rabilink-aiui-transcript-queue";
const AGENT_MESSAGE_QUEUE_KEY = "rabilink-aiui-agent-message-queue";
const MAX_TRANSCRIPT_QUEUE_LENGTH = 2000;
const MAX_TRANSCRIPT_QUEUE_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_AGENT_MESSAGE_QUEUE_LENGTH = 2000;
const MAX_AGENT_MESSAGE_QUEUE_AGE_MS = 48 * 60 * 60 * 1000;

function normalizeTranscriptQueue(value) {
  const source = Array.isArray(value) ? value : value?.messages;
  const cutoff = Date.now() - MAX_TRANSCRIPT_QUEUE_AGE_MS;
  return Array.isArray(source)
    ? source
      .filter((item) => {
        if (!item || typeof item !== "object" || !String(item.text || "").trim()) return false;
        const createdAt = Number(item.createdAt || 0);
        return !createdAt || createdAt >= cutoff;
      })
      .slice(-MAX_TRANSCRIPT_QUEUE_LENGTH)
    : [];
}

function hasStoredQueue(value) {
  return Array.isArray(value)
    || Boolean(value && typeof value === "object" && Array.isArray(value.messages));
}

function storageScope(value = "") {
  return String(value || "unbound").replace(/[^0-9A-Za-z._-]/g, "_");
}

function transcriptQueueStorageKey(tokenKey = "") {
  return `${TRANSCRIPT_QUEUE_KEY}:${storageScope(tokenKey)}`;
}

function normalizeAgentMessageQueue(value, expectedTokenKey = "") {
  const storedTokenKey = value && typeof value === "object" && !Array.isArray(value)
    ? String(value.tokenKey || "")
    : "";
  if (storedTokenKey && expectedTokenKey && storedTokenKey !== expectedTokenKey) return [];
  const source = Array.isArray(value) ? value : value?.messages;
  const cutoff = Date.now() - MAX_AGENT_MESSAGE_QUEUE_AGE_MS;
  const seen = new Set();
  const rows = [];
  for (const item of Array.isArray(source) ? source : []) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "").trim();
    const text = String(item.text || "").trim();
    const createdAt = Number(item.createdAt || 0);
    if (!id || !text || (createdAt && createdAt < cutoff) || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      text,
      createdAt: createdAt || Date.now(),
      proactive: item.proactive === true,
      source: String(item.source || "").trim(),
      attempts: Math.max(0, Math.min(3, Number(item.attempts || 0)))
    });
  }
  return rows.slice(-MAX_AGENT_MESSAGE_QUEUE_LENGTH);
}

function agentMessageQueueStorageKey(tokenKey = "") {
  return `${AGENT_MESSAGE_QUEUE_KEY}:${storageScope(tokenKey)}`;
}

function removeStorage(key) {
  if (typeof wx.removeStorageSync === "function") wx.removeStorageSync(key);
}

function hashTokenPart(value, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function loadSettings(defaults = {}) {
  const cached = readStorage();
  return {
    relayBaseUrl: cached.relayBaseUrl || defaults.relayBaseUrl || "",
    token: "",
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
  delete next.token;
  wx.setStorageSync(STORAGE_KEY, next);
  return next;
}

export function maskToken(token) {
  const text = String(token || "").trim();
  if (!text) return "未设置";
  if (text.length <= 10) return "已设置";
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

export function tokenStorageKey(token) {
  const text = String(token || "").trim();
  if (!text) return "unbound";
  const reversed = Array.from(text).reverse().join("");
  return `v2-${hashTokenPart(`primary:${text}`, 2166136261)}${hashTokenPart(`secondary:${text.length}:${reversed}`, 3339675911)}`;
}

export function loadTranscriptQueue(tokenKey = "") {
  try {
    const normalizedTokenKey = storageScope(tokenKey);
    const scopedKey = transcriptQueueStorageKey(normalizedTokenKey);
    const scopedValue = wx.getStorageSync(scopedKey);
    if (hasStoredQueue(scopedValue)) return normalizeTranscriptQueue(scopedValue);

    const migrationKeys = normalizedTokenKey === "unbound"
      ? [TRANSCRIPT_QUEUE_KEY]
      : [transcriptQueueStorageKey("unbound"), TRANSCRIPT_QUEUE_KEY];
    for (const migrationKey of migrationKeys) {
      const migrationValue = wx.getStorageSync(migrationKey);
      if (!hasStoredQueue(migrationValue)) continue;
      const next = normalizeTranscriptQueue(migrationValue);
      removeStorage(migrationKey);
      if (!next.length) continue;
      wx.setStorageSync(scopedKey, { tokenKey: normalizedTokenKey, messages: next });
      return next;
    }
    return [];
  } catch (error) {
    return [];
  }
}

export function saveTranscriptQueue(queue, tokenKey = "") {
  const normalizedTokenKey = storageScope(tokenKey);
  const next = normalizeTranscriptQueue(queue);
  wx.setStorageSync(
    transcriptQueueStorageKey(normalizedTokenKey),
    { tokenKey: normalizedTokenKey, messages: next }
  );
  return next;
}

export function loadAgentMessageQueue(tokenKey = "", legacyTokenKey = "") {
  try {
    const normalizedTokenKey = storageScope(tokenKey);
    const scopedKey = agentMessageQueueStorageKey(normalizedTokenKey);
    const scopedValue = wx.getStorageSync(scopedKey);
    if (hasStoredQueue(scopedValue)) {
      return normalizeAgentMessageQueue(scopedValue, normalizedTokenKey);
    }

    const normalizedLegacyTokenKey = storageScope(legacyTokenKey);
    if (legacyTokenKey && normalizedLegacyTokenKey !== normalizedTokenKey) {
      const legacyKey = agentMessageQueueStorageKey(normalizedLegacyTokenKey);
      const legacyValue = wx.getStorageSync(legacyKey);
      if (hasStoredQueue(legacyValue)) {
        const next = normalizeAgentMessageQueue(legacyValue, String(legacyValue?.tokenKey || normalizedLegacyTokenKey));
        wx.setStorageSync(scopedKey, { tokenKey: normalizedTokenKey, messages: next });
        removeStorage(legacyKey);
        return next;
      }
    }
    return [];
  } catch (error) {
    return [];
  }
}

export function saveAgentMessageQueue(queue, tokenKey = "") {
  const normalizedTokenKey = storageScope(tokenKey);
  const next = normalizeAgentMessageQueue({ tokenKey: normalizedTokenKey, messages: queue }, normalizedTokenKey);
  wx.setStorageSync(agentMessageQueueStorageKey(normalizedTokenKey), { tokenKey: normalizedTokenKey, messages: next });
  return next;
}

function readStorage() {
  try {
    const cached = wx.getStorageSync(STORAGE_KEY) || {};
    if (!cached || typeof cached !== "object" || Array.isArray(cached)) return {};
    if (!Object.prototype.hasOwnProperty.call(cached, "token")) return cached;
    const sanitized = { ...cached };
    delete sanitized.token;
    wx.setStorageSync(STORAGE_KEY, sanitized);
    return sanitized;
  } catch (error) {
    return {};
  }
}
