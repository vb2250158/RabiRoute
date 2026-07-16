import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const LEVELS = new Set(["debug", "info", "warn", "error", "fatal"]);
const SENSITIVE_KEY_PATTERN = /token|authorization|cookie|password|secret|credential|api[_-]?key|headers|body/i;
function boundedText(value, maxLength = 1000) {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

export function redactDeviceLogText(value, maxLength = 1000) {
  let text = boundedText(value, maxLength * 2);
  text = text
    .replace(/\brbl_[0-9A-Za-z_-]{12,}\b/g, "[redacted]")
    .replace(/\bBearer\s+[0-9A-Za-z._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(^|[?&\s])((?:token|access_token|api_key)=)[^&#\s]+/gi, "$1$2[redacted]")
    .replace(/(X-RabiLink-Token\s*[:=]\s*)\S+/gi, "$1[redacted]");
  return boundedText(text, maxLength);
}

export function sanitizeDeviceLogValue(value, depth = 0, key = "") {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) return value == null || value === "" ? value : "[redacted]";
  if (depth >= 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeDeviceLogValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 60).map(([entryKey, entryValue]) => [
        boundedText(entryKey, 80),
        sanitizeDeviceLogValue(entryValue, depth + 1, entryKey)
      ])
    );
  }
  if (typeof value === "string") return redactDeviceLogText(value, 500);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  return boundedText(value, 200);
}

function safeId(value, fallback = "unknown") {
  const text = boundedText(value, 120).replace(/[^0-9A-Za-z._:-]/g, "_");
  return text || fallback;
}

function isoTime(value, fallback) {
  const timestamp = typeof value === "number" ? value : Date.parse(String(value || ""));
  const date = new Date(Number.isFinite(timestamp) ? timestamp : fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback).toISOString() : date.toISOString();
}

function logFilePath(directory, accountId) {
  return path.join(directory, `${safeId(accountId, "")}.jsonl`);
}

function readRows(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeRows(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "", "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function normalizeDeviceLogBatch(body = {}, context = {}, options = {}) {
  const receivedAtMs = Number(options.receivedAtMs || Date.now());
  const receivedAt = new Date(receivedAtMs).toISOString();
  const sourceRows = Array.isArray(body.logs) ? body.logs : (Array.isArray(body.entries) ? body.entries : []);
  const deviceId = safeId(body.deviceId || body.serialNumber || body.deviceSerialNumber, "unidentified-glasses");
  const deviceKind = safeId(body.deviceKind || "glasses", "glasses");
  const deviceName = redactDeviceLogText(body.deviceName || body.name || deviceId, 120);
  const source = safeId(body.source || context.source || "unknown-app", "unknown-app");
  const appVersion = redactDeviceLogText(body.appVersion || body.version || "", 80);
  const sessionId = safeId(body.sessionId || "", "");
  const mode = safeId(body.mode || "", "");
  const appId = safeId(context.appId || "", "");
  const appName = redactDeviceLogText(context.appName || "", 120);

  return sourceRows.slice(0, 50).map((entry = {}) => {
    const levelValue = String(entry.level || "info").toLowerCase();
    const level = LEVELS.has(levelValue) ? levelValue : "info";
    const message = redactDeviceLogText(entry.message || entry.text || entry.detail || entry.error || "", 1000);
    return {
      id: `dlog-${randomUUID()}`,
      clientId: safeId(entry.id || entry.clientId || "", ""),
      time: isoTime(entry.time || entry.createdAt || entry.timestamp, receivedAtMs),
      receivedAt,
      level,
      event: safeId(entry.event || entry.category || `device.${level}`, `device.${level}`),
      message,
      deviceId,
      deviceKind,
      deviceName,
      source,
      appId,
      appName,
      appVersion,
      sessionId,
      mode,
      context: sanitizeDeviceLogValue(entry.context || entry.meta || {})
    };
  });
}

export function appendDeviceLogs(options = {}) {
  const directory = path.resolve(options.directory || ".");
  const accountId = safeId(options.accountId, "");
  if (!accountId) throw new Error("accountId is required");
  const maxRows = Math.max(100, Math.min(50000, Number(options.maxRows || 5000)));
  const filePath = logFilePath(directory, accountId);
  const existing = readRows(filePath);
  const knownKeys = new Set(existing.map((row) => row.clientId ? `${row.appId}:${row.deviceId}:${row.clientId}` : "").filter(Boolean));
  const normalized = normalizeDeviceLogBatch(options.body, {
    appId: options.appId,
    appName: options.appName,
    source: options.source
  }, { receivedAtMs: options.receivedAtMs });
  const accepted = [];
  let duplicateCount = 0;
  for (const row of normalized) {
    const key = row.clientId ? `${row.appId}:${row.deviceId}:${row.clientId}` : "";
    if (key && knownKeys.has(key)) {
      duplicateCount += 1;
      continue;
    }
    if (key) knownKeys.add(key);
    accepted.push(row);
  }
  writeRows(filePath, [...existing, ...accepted].slice(-maxRows));
  return { accepted, acceptedCount: accepted.length, duplicateCount };
}

export function readDeviceLogs(options = {}) {
  const directory = path.resolve(options.directory || ".");
  const accountId = safeId(options.accountId, "");
  if (!accountId) return [];
  const limit = Math.max(1, Math.min(500, Number(options.limit || 120)));
  const fromMs = options.from ? Date.parse(String(options.from)) : Number.NaN;
  const toMs = options.to ? Date.parse(String(options.to)) : Number.NaN;
  const filters = {
    deviceId: boundedText(options.deviceId, 120),
    deviceKind: boundedText(options.deviceKind, 80),
    source: boundedText(options.source, 120),
    appId: boundedText(options.appId, 120),
    level: boundedText(options.level, 20).toLowerCase(),
    sessionId: boundedText(options.sessionId, 120),
    query: boundedText(options.query, 200).toLowerCase()
  };
  return readRows(logFilePath(directory, accountId))
    .filter((row) => !filters.deviceId || row.deviceId === filters.deviceId)
    .filter((row) => !filters.deviceKind || row.deviceKind === filters.deviceKind)
    .filter((row) => !filters.source || row.source === filters.source)
    .filter((row) => !filters.appId || row.appId === filters.appId)
    .filter((row) => !filters.level || row.level === filters.level)
    .filter((row) => !filters.sessionId || row.sessionId === filters.sessionId)
    .filter((row) => !Number.isFinite(fromMs) || Date.parse(row.time) >= fromMs)
    .filter((row) => !Number.isFinite(toMs) || Date.parse(row.time) <= toMs)
    .filter((row) => !filters.query || `${row.event} ${row.message} ${row.deviceName} ${row.source}`.toLowerCase().includes(filters.query))
    .slice(-limit)
    .reverse();
}

export function deviceLogFacets(rows = []) {
  const unique = (key) => [...new Set(rows.map((row) => String(row?.[key] || "")).filter(Boolean))].sort();
  return {
    devices: unique("deviceId"),
    deviceKinds: unique("deviceKind"),
    sources: unique("source"),
    apps: unique("appId"),
    levels: unique("level")
  };
}
