#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

const port = Number(process.env.PORT || process.env.RABILINK_RELAY_PORT || 8788);
const host = process.env.HOST || process.env.RABILINK_RELAY_HOST || "0.0.0.0";
const legacyToken = process.env.RABILINK_RELAY_TOKEN || "";
const allowInsecure = process.env.RABILINK_RELAY_ALLOW_INSECURE === "1";
const replyTimeoutMs = clamp(Number(process.env.RABILINK_RELAY_REPLY_TIMEOUT_MS || 60000), 1000, 120000);
const messageWaitMs = clamp(Number(process.env.RABILINK_RELAY_MESSAGE_WAIT_MS || 60000), 0, 60000);
const outboxWaitMs = clamp(Number(process.env.RABILINK_RELAY_OUTBOX_WAIT_MS || 60000), 0, 60000);
const workerTaskWaitMs = clamp(Number(process.env.RABILINK_RELAY_WORKER_TASK_WAIT_MS || 60000), 0, 60000);
const taskTtlMs = clamp(Number(process.env.RABILINK_RELAY_TASK_TTL_MS || 10 * 60 * 1000), 60000, 24 * 60 * 60 * 1000);
const leaseMs = clamp(Number(process.env.RABILINK_RELAY_LEASE_MS || 45000), 5000, 10 * 60 * 1000);
const dataDir = path.resolve(process.env.RABILINK_RELAY_DATA_DIR || path.join(process.cwd(), "data", "rabilink-relay"));
const eventLogPath = path.join(dataDir, "events.jsonl");
const appStorePath = path.resolve(process.env.RABILINK_RELAY_APP_STORE_FILE || path.join(dataDir, "apps.json"));
const openApiFileCandidates = [
  process.env.RABILINK_RELAY_OPENAPI_FILE ? path.resolve(process.env.RABILINK_RELAY_OPENAPI_FILE) : "",
  path.join(dataDir, "rokid-rabilink-plugin.CURRENT.openapi.json"),
  path.join(process.cwd(), "rokid-rabilink-plugin.CURRENT.openapi.json")
].filter(Boolean);
const manualAuthOpenApiFileCandidates = [
  process.env.RABILINK_RELAY_MANUAL_AUTH_OPENAPI_FILE ? path.resolve(process.env.RABILINK_RELAY_MANUAL_AUTH_OPENAPI_FILE) : "",
  path.join(dataDir, "rokid-rabilink-plugin.MANUAL_AUTH.openapi.json"),
  path.join(process.cwd(), "rokid-rabilink-plugin.MANUAL_AUTH.openapi.json")
].filter(Boolean);
const toolImportPostmanFileCandidates = [
  process.env.RABILINK_RELAY_TOOL_IMPORT_POSTMAN_FILE ? path.resolve(process.env.RABILINK_RELAY_TOOL_IMPORT_POSTMAN_FILE) : "",
  path.join(dataDir, "rokid-rabilink-tools-import.CURRENT.postman.json"),
  path.join(process.cwd(), "rokid-rabilink-tools-import.CURRENT.postman.json")
].filter(Boolean);

fs.mkdirSync(dataDir, { recursive: true });
if (!legacyToken && !allowInsecure && !hasEnabledRabiLinkApps()) {
  console.warn("RABILINK_RELAY_TOKEN is not set and no enabled app tokens exist yet. Open /admin to create the first account and app token.");
}

/** @type {Map<string, RelayTask>} */
const tasks = new Map();
/** @type {RelayOutboxMessage[]} */
const outboxMessages = [];
let nextOutboxMessageSeq = 1;
/** @type {Array<{ resolve: (value: RelayTask) => void; taskId: string; timer: NodeJS.Timeout }>} */
const waiters = [];
/** @type {Array<{ resolve: () => void; timer: NodeJS.Timeout }>} */
const workerTaskWaiters = [];
/** @type {Array<{ resolve: () => void; timer: NodeJS.Timeout }>} */
const outboxWaiters = [];

/**
 * @typedef {object} RelayTask
 * @property {string} id
 * @property {string} status
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} expiresAt
 * @property {number} leaseUntil
 * @property {number} attempts
 * @property {string} text
 * @property {string} normalizedText
 * @property {string} appId
 * @property {string} appName
 * @property {Record<string, unknown>} source
 * @property {unknown} raw
 * @property {RelayMessage[]} messages
 * @property {number} nextMessageSeq
 * @property {string} [replyText]
 * @property {unknown} [replyRaw]
 * @property {string} [error]
 */

/**
 * @typedef {object} RelayMessage
 * @property {string} id
 * @property {number} seq
 * @property {number} createdAt
 * @property {string} text
 * @property {boolean} final
 * @property {unknown} raw
 */

/**
 * @typedef {object} RelayOutboxMessage
 * @property {string} id
 * @property {number} seq
 * @property {string} appId
 * @property {string} taskId
 * @property {string} taskMessageId
 * @property {number} createdAt
 * @property {string} text
 * @property {boolean} final
 * @property {string} status
 */

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function nowIso() {
  return new Date().toISOString();
}

function writeEvent(event, data) {
  const row = JSON.stringify({ time: nowIso(), event, data });
  fs.appendFile(eventLogPath, `${row}\n`, () => {});
}

function rabiLinkTokenPreview(value) {
  const tokenText = String(value || "");
  return tokenText.length <= 12 ? tokenText : `${tokenText.slice(0, 8)}...${tokenText.slice(-4)}`;
}

function generateRabiLinkToken() {
  return `rbl_${randomBytes(24).toString("base64url")}`;
}

function randomId(prefix) {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

function passwordHash(password, salt = randomBytes(16).toString("hex")) {
  return {
    salt,
    hash: scryptSync(String(password || ""), salt, 32).toString("hex")
  };
}

function verifyPassword(password, account) {
  if (!account?.passwordHash || !account?.passwordSalt) return false;
  const expected = Buffer.from(account.passwordHash, "hex");
  const actual = scryptSync(String(password || ""), account.passwordSalt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sanitizeRabiLinkId(value, fallback) {
  const raw = String(value || "").trim();
  return raw.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "") || fallback;
}

function readAppStore() {
  if (!fs.existsSync(appStorePath)) {
    return { accounts: [], apps: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(appStorePath, "utf8"));
    return {
      accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
      apps: Array.isArray(raw.apps)
        ? raw.apps.map((app) => ({
          ...app,
          enabled: app.enabled !== false,
          tokenPreview: app.tokenPreview || rabiLinkTokenPreview(app.token)
        }))
        : []
    };
  } catch (error) {
    writeEvent("app_store_read_failed", { path: appStorePath, message: error instanceof Error ? error.message : String(error) });
    return { accounts: [], apps: [] };
  }
}

function writeAppStore(store) {
  fs.mkdirSync(path.dirname(appStorePath), { recursive: true });
  fs.writeFileSync(appStorePath, JSON.stringify({
    accounts: store.accounts,
    apps: store.apps
  }, null, 2), "utf8");
}

function hasEnabledRabiLinkApps() {
  return readAppStore().apps.some((app) => app.enabled !== false && app.token);
}

function findEnabledAppByToken(value) {
  const requestText = String(value || "");
  if (!requestText) return null;
  return readAppStore().apps.find((app) => app.enabled !== false && app.token === requestText) || null;
}

function publicAccount(account) {
  return {
    id: account.id,
    username: account.username,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

function publicApp(app, options = {}) {
  return {
    id: app.id,
    name: app.name,
    ownerAccountId: app.ownerAccountId,
    enabled: app.enabled !== false,
    tokenPreview: app.tokenPreview || rabiLinkTokenPreview(app.token),
    token: options.revealToken ? app.token : undefined,
    notes: app.notes || "",
    createdAt: app.createdAt,
    updatedAt: app.updatedAt
  };
}

function accountStorePayload(account, options = {}) {
  const store = readAppStore();
  const apps = account
    ? store.apps.filter((app) => app.ownerAccountId === account.id)
    : [];
  return {
    code: 0,
    ok: true,
    setupRequired: store.accounts.length === 0,
    account: account ? publicAccount(account) : null,
    apps: apps.map((app) => publicApp(app, { revealToken: app.id === options.revealAppId })),
    dataPath: path.relative(process.cwd(), appStorePath).replace(/\\/g, "/")
  };
}

function createAccount(body) {
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!/^[\p{L}\p{N}_@.-]{3,48}$/u.test(username)) {
    const error = new Error("账号名需要 3-48 位，可包含中文、字母、数字、下划线、点、@ 或短横线。");
    error.statusCode = 400;
    throw error;
  }
  if (password.length < 6) {
    const error = new Error("密码至少需要 6 位。");
    error.statusCode = 400;
    throw error;
  }
  const store = readAppStore();
  if (store.accounts.some((account) => account.username.toLowerCase() === username.toLowerCase())) {
    const error = new Error(`账号 ${username} 已存在。`);
    error.statusCode = 409;
    throw error;
  }
  const time = nowIso();
  const { hash, salt } = passwordHash(password);
  const account = {
    id: randomId("account"),
    username,
    passwordHash: hash,
    passwordSalt: salt,
    createdAt: time,
    updatedAt: time
  };
  store.accounts.push(account);
  writeAppStore(store);
  writeEvent("admin_account_created", { account: publicAccount(account) });
  return account;
}

function loginAccount(body) {
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const account = readAppStore().accounts.find((item) => item.username.toLowerCase() === username.toLowerCase());
  if (!account || !verifyPassword(password, account)) {
    const error = new Error("账号或密码不正确。");
    error.statusCode = 401;
    throw error;
  }
  return account;
}

function adminCredentials(req, url, body = {}) {
  const header = String(req.headers["x-rabilink-admin-auth"] || "");
  const basic = String(req.headers.authorization || "").match(/^Basic\s+(.+)$/i)?.[1] || "";
  const encoded = header || basic || url.searchParams.get("adminAuth") || "";
  if (encoded) {
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const split = decoded.indexOf(":");
      if (split >= 0) {
        return { username: decoded.slice(0, split), password: decoded.slice(split + 1) };
      }
    } catch {
      return { username: "", password: "" };
    }
  }
  return {
    username: String(body.username || ""),
    password: String(body.password || "")
  };
}

function authorizeAdmin(req, url, body = {}) {
  const store = readAppStore();
  if (store.accounts.length === 0) return { ok: false, setupRequired: true, account: null };
  const credentials = adminCredentials(req, url, body);
  const account = store.accounts.find((item) => item.username.toLowerCase() === credentials.username.toLowerCase());
  if (!account || !verifyPassword(credentials.password, account)) {
    return { ok: false, setupRequired: false, account: null };
  }
  return { ok: true, setupRequired: false, account };
}

function createAppForAccount(account, body) {
  const store = readAppStore();
  const time = nowIso();
  const tokenValue = generateRabiLinkToken();
  const baseId = sanitizeRabiLinkId(body.id, sanitizeRabiLinkId(body.name, "app"));
  let id = baseId;
  let suffix = 2;
  while (store.apps.some((app) => app.id === id)) {
    id = `${baseId}-${suffix++}`;
  }
  const app = {
    id,
    name: String(body.name || "").trim() || "RabiLink 应用",
    ownerAccountId: account.id,
    enabled: body.enabled !== false,
    token: tokenValue,
    tokenPreview: rabiLinkTokenPreview(tokenValue),
    notes: String(body.notes || "").trim(),
    createdAt: time,
    updatedAt: time
  };
  store.apps.push(app);
  writeAppStore(store);
  writeEvent("admin_app_created", { app: publicApp(app) });
  return app;
}

function patchOwnedApp(account, appId, body) {
  const store = readAppStore();
  const app = store.apps.find((item) => item.id === appId && item.ownerAccountId === account.id);
  if (!app) {
    const error = new Error(`RabiLink app not found: ${appId}`);
    error.statusCode = 404;
    throw error;
  }
  if (body.name !== undefined) app.name = String(body.name || "").trim() || app.name;
  if (body.notes !== undefined) app.notes = String(body.notes || "").trim();
  if (body.enabled !== undefined) app.enabled = body.enabled !== false;
  const revealToken = body.regenerateToken === true;
  if (revealToken) {
    app.token = generateRabiLinkToken();
    app.tokenPreview = rabiLinkTokenPreview(app.token);
  }
  app.updatedAt = nowIso();
  writeAppStore(store);
  writeEvent("admin_app_updated", { app: publicApp(app), regenerateToken: revealToken });
  return { app, revealToken };
}

function deleteOwnedApp(account, appId) {
  const store = readAppStore();
  const index = store.apps.findIndex((item) => item.id === appId && item.ownerAccountId === account.id);
  if (index < 0) {
    const error = new Error(`RabiLink app not found: ${appId}`);
    error.statusCode = 404;
    throw error;
  }
  const [removed] = store.apps.splice(index, 1);
  writeAppStore(store);
  writeEvent("admin_app_deleted", { app: publicApp(removed) });
}

function sendJson(res, statusCode, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-rabilink-token,x-rabilink-admin-auth"
  });
  res.end(text);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(html);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*"
  });
  res.end(text);
}

function sendOpenApi(res, candidates = openApiFileCandidates) {
  const filePath = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!filePath) {
    return sendJson(res, 404, { code: -1, ok: false, message: "OpenAPI document was not found." });
  }
  const text = fs.readFileSync(filePath, "utf8");
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store"
  });
  res.end(text);
}

function requestToken(req, url, body) {
  const auth = String(req.headers.authorization || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return String(req.headers["x-rabilink-token"] || bearer || url.searchParams.get("token") || body?.token || "");
}

function authorizeRabiLinkRequest(req, url, body) {
  const requestTokenValue = requestToken(req, url, body);
  if (legacyToken && requestTokenValue === legacyToken) {
    return { ok: true, app: null, legacy: true, insecure: false };
  }
  const app = findEnabledAppByToken(requestTokenValue);
  if (app) {
    return { ok: true, app, legacy: false, insecure: false };
  }
  if (!legacyToken && allowInsecure) {
    return { ok: true, app: null, legacy: false, insecure: true };
  }
  return { ok: false, app: null, legacy: false, insecure: false };
}

function canAccessTask(auth, task) {
  if (auth.legacy || auth.insecure) return true;
  return Boolean(auth.app && task.appId === auth.app.id);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("error", reject);
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      const type = String(req.headers["content-type"] || "");
      if (type.includes("application/x-www-form-urlencoded")) {
        return resolve(Object.fromEntries(new URLSearchParams(text)));
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({ text });
      }
    });
  });
}

function stringValue(value) {
  return value == null ? "" : String(value).trim();
}

function extractText(body) {
  if (typeof body === "string") return body.trim();
  if (!body || typeof body !== "object") return "";
  const direct = [
    body.text,
    body.message,
    body.query,
    body.prompt,
    body.input,
    body.question,
    body.content,
    body.data && typeof body.data === "object" ? body.data.text : "",
    body.data && typeof body.data === "object" ? body.data.message : ""
  ].map(stringValue).find(Boolean);
  if (direct) return direct;
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const last = body.messages[body.messages.length - 1];
    if (typeof last === "string") return last.trim();
    if (last && typeof last === "object") return stringValue(last.content || last.text || last.message);
  }
  return "";
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function taskForResponse(task) {
  return {
    id: task.id,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expiresAt: task.expiresAt,
    attempts: task.attempts,
    text: task.text,
    normalizedText: task.normalizedText,
    appId: task.appId || "",
    appName: task.appName || "",
    source: task.source,
    messageCount: task.messages.length,
    nextMessageSeq: task.nextMessageSeq,
    replyText: task.replyText || "",
    error: task.error || ""
  };
}

function createTask(raw, req, auth = { app: null }) {
  const text = extractText(raw);
  if (!text) {
    const error = new Error("Missing text/message/query/content in request body.");
    error.statusCode = 400;
    throw error;
  }
  const now = Date.now();
  const task = {
    id: `rabilink-relay-${now}-${randomUUID().slice(0, 8)}`,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + taskTtlMs,
    leaseUntil: 0,
    attempts: 0,
    text,
    normalizedText: normalizeText(text),
    appId: auth.app?.id || "",
    appName: auth.app?.name || "",
    source: {
      userAgent: String(req.headers["user-agent"] || ""),
      ip: String(req.socket.remoteAddress || ""),
      rokidRequestId: stringValue(raw?.requestId || raw?.id || raw?.messageId),
      sender: stringValue(raw?.sender || raw?.user || raw?.deviceId),
      appId: auth.app?.id || "",
      appName: auth.app?.name || ""
    },
    raw,
    messages: [],
    nextMessageSeq: 1
  };
  tasks.set(task.id, task);
  writeEvent("task_created", taskForResponse(task));
  notifyWorkerTaskWaiters();
  return task;
}

function cleanupTasks() {
  const now = Date.now();
  for (const [id, task] of tasks.entries()) {
    if (task.status !== "done" && task.status !== "failed" && task.expiresAt <= now) {
      task.status = "expired";
      task.updatedAt = now;
      task.error = "Task expired before RabiLink worker returned a result.";
      finishWaiters(task);
      writeEvent("task_expired", taskForResponse(task));
    }
    if ((task.status === "done" || task.status === "failed" || task.status === "expired") && task.updatedAt + taskTtlMs <= now) {
      tasks.delete(id);
    }
  }
  cleanupOutboxMessages(now);
}

function cleanupOutboxMessages(now = Date.now()) {
  const firstLiveIndex = outboxMessages.findIndex((message) => message.createdAt + taskTtlMs > now);
  if (firstLiveIndex > 0) {
    outboxMessages.splice(0, firstLiveIndex);
  } else if (firstLiveIndex < 0 && outboxMessages.length > 0) {
    outboxMessages.splice(0, outboxMessages.length);
  }
}

function claimTasks(limit, deviceId, appId = "") {
  cleanupTasks();
  const now = Date.now();
  const result = [];
  for (const task of tasks.values()) {
    if (result.length >= limit) break;
    if (appId && task.appId !== appId) continue;
    if (task.status === "leased" && task.leaseUntil <= now) {
      task.status = "queued";
      task.leaseUntil = 0;
    }
    if (task.status !== "queued") continue;
    task.status = "leased";
    task.updatedAt = now;
    task.leaseUntil = now + leaseMs;
    task.attempts += 1;
    task.source = { ...task.source, leasedBy: deviceId || "" };
    result.push(taskForResponse(task));
    writeEvent("task_leased", taskForResponse(task));
  }
  return result;
}

function hasClaimableTasks(appId = "") {
  cleanupTasks();
  const now = Date.now();
  for (const task of tasks.values()) {
    if (appId && task.appId !== appId) continue;
    if (task.status === "queued") return true;
    if (task.status === "leased" && task.leaseUntil <= now) return true;
  }
  return false;
}

function notifyWorkerTaskWaiters() {
  for (let index = workerTaskWaiters.length - 1; index >= 0; index -= 1) {
    const waiter = workerTaskWaiters[index];
    clearTimeout(waiter.timer);
    workerTaskWaiters.splice(index, 1);
    waiter.resolve();
  }
}

function notifyOutboxWaiters() {
  for (let index = outboxWaiters.length - 1; index >= 0; index -= 1) {
    const waiter = outboxWaiters[index];
    clearTimeout(waiter.timer);
    outboxWaiters.splice(index, 1);
    waiter.resolve();
  }
}

function waitForClaimableTask(timeoutMs, appId = "") {
  if (hasClaimableTasks(appId) || timeoutMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = workerTaskWaiters.findIndex((item) => item.resolve === resolve);
      if (index >= 0) workerTaskWaiters.splice(index, 1);
      resolve();
    }, timeoutMs);
    workerTaskWaiters.push({ resolve, timer });
  });
}

function findTaskOrThrow(taskId) {
  const task = tasks.get(taskId);
  if (!task) {
    const error = new Error(`Task not found: ${taskId}`);
    error.statusCode = 404;
    throw error;
  }
  return task;
}

function appendTaskMessages(taskId, body, options = {}) {
  const task = findTaskOrThrow(taskId);
  const inputMessages = Array.isArray(body?.messages) ? body.messages : [body];
  const created = [];
  for (const item of inputMessages) {
    const text = extractText(item);
    if (!text) continue;
    const seq = task.nextMessageSeq;
    task.nextMessageSeq += 1;
    const message = {
      id: `msg-${String(seq).padStart(6, "0")}`,
      seq,
      createdAt: Date.now(),
      text,
      final: Boolean(item?.final || options.final),
      raw: item
    };
    task.messages.push(message);
    created.push(message);
  }
  if (created.length === 0) {
    const error = new Error("Missing text/message/query/content in message body.");
    error.statusCode = 400;
    throw error;
  }
  task.updatedAt = Date.now();
  task.leaseUntil = 0;
  task.replyText = created.map((message) => message.text).join("\n");
  if (task.status !== "done" && task.status !== "failed") {
    task.status = options.finish ? "done" : "streaming";
  }
  if (options.finish) {
    task.status = "done";
  }
  appendOutboxMessages(task, created);
  finishWaiters(task);
  writeEvent(options.finish ? "task_messages_finished" : "task_messages_appended", {
    task: taskForResponse(task),
    messages: created.map(messageForResponse)
  });
  return { task, messages: created };
}

function appendOutboxMessages(task, messages) {
  for (const message of messages) {
    const seq = nextOutboxMessageSeq;
    nextOutboxMessageSeq += 1;
    outboxMessages.push({
      id: `out-${String(seq).padStart(9, "0")}`,
      seq,
      appId: task.appId || "",
      taskId: task.id,
      taskMessageId: message.id,
      createdAt: message.createdAt,
      text: message.text,
      final: message.final,
      status: task.status
    });
  }
  notifyOutboxWaiters();
}

function currentOutboxCursor() {
  return outboxMessages[outboxMessages.length - 1]?.id || "";
}

function messageForResponse(message) {
  return {
    id: message.id,
    seq: message.seq,
    createdAt: message.createdAt,
    text: message.text,
    final: message.final
  };
}

function outboxMessageForResponse(message) {
  return {
    id: message.id,
    seq: message.seq,
    appId: message.appId || "",
    taskId: message.taskId,
    taskMessageId: message.taskMessageId,
    createdAt: message.createdAt,
    text: message.text,
    final: message.final,
    status: message.status
  };
}

function hasOpenTasks(appId = "") {
  cleanupTasks();
  for (const task of tasks.values()) {
    if (appId && task.appId !== appId) continue;
    if (!isTerminalTask(task)) return true;
  }
  return false;
}

function hasOutboxMessagesAfter(after, appId = "") {
  const afterText = stringValue(after);
  const afterSeq = Number(afterText.replace(/^out-/, ""));
  return outboxMessages.some((message) => {
    if (appId && message.appId !== appId) return false;
    if (!afterText) return true;
    if (Number.isFinite(afterSeq) && afterSeq > 0) return message.seq > afterSeq;
    return message.id > afterText;
  });
}

function outboxMessagesAfter(after, appId = "") {
  const afterText = stringValue(after);
  const afterSeq = Number(afterText.replace(/^out-/, ""));
  return outboxMessages.filter((message) => {
    if (appId && message.appId !== appId) return false;
    if (!afterText) return true;
    if (Number.isFinite(afterSeq) && afterSeq > 0) return message.seq > afterSeq;
    return message.id > afterText;
  });
}

function outboxMessagesResponse(after, appId = "") {
  cleanupTasks();
  const messages = outboxMessagesAfter(after, appId);
  const visibleMessages = appId ? outboxMessages.filter((message) => message.appId === appId) : outboxMessages;
  const last = messages[messages.length - 1] || visibleMessages[visibleMessages.length - 1];
  const openTasks = hasOpenTasks(appId);
  const text = messages.map((message) => message.text).join("\n");
  const shouldContinue = openTasks;
  return {
    code: 0,
    ok: true,
    status: messages.length > 0 ? "messages" : openTasks ? "idle" : "done",
    done: !openTasks,
    shouldContinue,
    cursor: last?.id || stringValue(after),
    nextCursor: last?.id || stringValue(after),
    messages: messages.map(outboxMessageForResponse),
    text,
    answer: text,
    reply: text,
    content: text,
    error: ""
  };
}

async function waitForOutboxMessagesAfter(after, timeoutMs, appId = "") {
  if (hasOutboxMessagesAfter(after, appId) || timeoutMs <= 0) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = outboxWaiters.findIndex((item) => item.resolve === resolve);
      if (index >= 0) outboxWaiters.splice(index, 1);
      resolve();
    }, timeoutMs);
    outboxWaiters.push({ resolve, timer });
  });
}

function taskMessagesResponse(task, after) {
  const afterText = stringValue(after);
  const afterSeq = Number(afterText.replace(/^msg-/, ""));
  const messages = task.messages.filter((message) => {
    if (!afterText) return true;
    if (Number.isFinite(afterSeq) && afterSeq > 0) return message.seq > afterSeq;
    return message.id > afterText;
  });
  const last = messages[messages.length - 1] || task.messages[task.messages.length - 1];
  const done = task.status === "done" || task.status === "failed" || task.status === "expired";
  const shouldContinue = !done;
  return {
    code: task.status === "failed" ? -1 : 0,
    ok: task.status !== "failed" && task.status !== "expired",
    status: task.status === "done" ? "done" : task.status === "failed" || task.status === "expired" ? "failed" : "streaming",
    taskId: task.id,
    done,
    shouldContinue,
    cursor: last?.id || afterText || "",
    nextCursor: last?.id || afterText || "",
    messages: messages.map(messageForResponse),
    text: messages.map((message) => message.text).join("\n"),
    answer: messages.map((message) => message.text).join("\n"),
    reply: messages.map((message) => message.text).join("\n"),
    content: messages.map((message) => message.text).join("\n"),
    error: task.error || ""
  };
}

function hasMessagesAfter(task, after) {
  const afterText = stringValue(after);
  const afterSeq = Number(afterText.replace(/^msg-/, ""));
  return task.messages.some((message) => {
    if (!afterText) return true;
    if (Number.isFinite(afterSeq) && afterSeq > 0) return message.seq > afterSeq;
    return message.id > afterText;
  });
}

function isTerminalTask(task) {
  return task.status === "done" || task.status === "failed" || task.status === "expired";
}

async function waitForMessagesAfter(task, after, timeoutMs) {
  if (hasMessagesAfter(task, after) || isTerminalTask(task) || timeoutMs <= 0) return task;
  return await waitForTask(task, timeoutMs);
}

function finishTask(taskId, body) {
  const task = findTaskOrThrow(taskId);
  const ok = body?.ok !== false && body?.status !== "failed";
  const replyText = stringValue(body?.replyText || body?.text || body?.answer || body?.content || body?.message);
  if (ok && replyText) {
    appendTaskMessages(taskId, { text: replyText, final: true, raw: body }, { finish: true, final: true });
  }
  task.status = ok ? "done" : "failed";
  task.updatedAt = Date.now();
  task.leaseUntil = 0;
  task.replyText = replyText;
  task.replyRaw = body;
  task.error = ok ? "" : stringValue(body?.error || body?.reason || "RabiLink worker reported failure.");
  finishWaiters(task);
  notifyOutboxWaiters();
  writeEvent(ok ? "task_done" : "task_failed", taskForResponse(task));
  return task;
}

function finishWaiters(task) {
  for (let index = waiters.length - 1; index >= 0; index -= 1) {
    const waiter = waiters[index];
    if (waiter.taskId !== task.id) continue;
    clearTimeout(waiter.timer);
    waiters.splice(index, 1);
    waiter.resolve(task);
  }
}

function waitForTask(task, timeoutMs) {
  if (task.status === "done" || task.status === "failed") return Promise.resolve(task);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = waiters.findIndex((item) => item.taskId === task.id && item.resolve === resolve);
      if (index >= 0) waiters.splice(index, 1);
      resolve(task);
    }, timeoutMs);
    waiters.push({ taskId: task.id, resolve, timer });
  });
}

function rokidResponse(task) {
  if (task.status === "done") {
    const text = task.replyText || "已转交 Codex 处理。";
    return {
      code: 0,
      ok: true,
      status: "done",
      taskId: task.id,
      text,
      answer: text,
      reply: text,
      content: text
    };
  }
  if (task.status === "failed") {
    const text = task.error || "RabiLink 转发失败。";
    return {
      code: -1,
      ok: false,
      status: "failed",
      taskId: task.id,
      text,
      answer: text,
      reply: text,
      content: text
    };
  }
  const text = "已收到，正在转交电脑端 RabiLink 和 Codex 处理。";
  return {
    code: 0,
    ok: true,
    status: "pending",
    taskId: task.id,
    text,
    answer: text,
    reply: text,
    content: text
  };
}

async function handleRokid(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  const task = createTask(body, req, auth);
  const wait = url.searchParams.get("wait");
  const shouldWait = wait == null || wait === "1" || wait.toLowerCase() === "true";
  const timeout = clamp(Number(url.searchParams.get("timeoutMs") || replyTimeoutMs), 1000, 120000);
  const finalTask = shouldWait ? await waitForTask(task, timeout) : task;
  sendJson(res, 200, rokidResponse(finalTask));
}

function handleRokidCreateTask(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  const outboxCursor = currentOutboxCursor();
  const task = createTask(body, req, auth);
  sendJson(res, 200, {
    code: 0,
    ok: true,
    status: "pending",
    taskId: task.id,
    cursor: outboxCursor,
    nextCursor: outboxCursor,
    text: "已收到，正在转交电脑端 RabiLink 和 Codex 处理。请稍后查询结果。",
    answer: "已收到，正在转交电脑端 RabiLink 和 Codex 处理。请稍后查询结果。",
    reply: "已收到，正在转交电脑端 RabiLink 和 Codex 处理。请稍后查询结果。",
    content: "已收到，正在转交电脑端 RabiLink 和 Codex 处理。请稍后查询结果。"
  });
}

function handleRokidTaskRead(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  const match = url.pathname.match(/^\/rokid\/rabilink\/tasks\/([^/]+)$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
  const task = tasks.get(taskId);
  if (!task) return sendJson(res, 404, {
    code: -1,
    ok: false,
    status: "failed",
    taskId,
    text: "没有找到这条 RabiLink 任务，可能已经过期。",
    answer: "没有找到这条 RabiLink 任务，可能已经过期。",
    reply: "没有找到这条 RabiLink 任务，可能已经过期。",
    content: "没有找到这条 RabiLink 任务，可能已经过期。"
  });
  if (!canAccessTask(auth, task)) return sendJson(res, 403, { code: -1, ok: false, message: "Forbidden" });
  cleanupTasks();
  sendJson(res, 200, rokidResponse(task));
}

async function handleRokidTaskMessages(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  const match = url.pathname.match(/^\/rokid\/rabilink\/tasks\/([^/]+)\/messages$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
  const task = tasks.get(taskId);
  if (!task) return sendJson(res, 404, {
    code: -1,
    ok: false,
    status: "failed",
    taskId,
    done: true,
    shouldContinue: false,
    messages: [],
    text: "没有找到这条 RabiLink 任务，可能已经过期。",
    answer: "没有找到这条 RabiLink 任务，可能已经过期。",
    reply: "没有找到这条 RabiLink 任务，可能已经过期。",
    content: "没有找到这条 RabiLink 任务，可能已经过期。"
  });
  if (!canAccessTask(auth, task)) return sendJson(res, 403, { code: -1, ok: false, message: "Forbidden" });
  cleanupTasks();
  const after = url.searchParams.get("after") || url.searchParams.get("cursor") || "";
  const waitMs = clamp(Number(url.searchParams.get("waitMs") || url.searchParams.get("timeoutMs") || messageWaitMs), 0, 60000);
  const finalTask = await waitForMessagesAfter(task, after, waitMs);
  sendJson(res, 200, taskMessagesResponse(finalTask, after));
}

async function handleRokidOutboxMessages(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  cleanupTasks();
  const appId = auth.app?.id || "";
  const hasCursor = url.searchParams.has("after") || url.searchParams.has("cursor");
  const after = hasCursor
    ? url.searchParams.get("after") || url.searchParams.get("cursor") || ""
    : currentOutboxCursor();
  const waitMs = clamp(Number(url.searchParams.get("waitMs") || url.searchParams.get("timeoutMs") || outboxWaitMs), 0, 60000);
  await waitForOutboxMessagesAfter(after, waitMs, appId);
  sendJson(res, 200, outboxMessagesResponse(after, appId));
}

async function handleWorkerTasks(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  const limit = clamp(Number(url.searchParams.get("limit") || 1), 1, 10);
  const deviceId = stringValue(url.searchParams.get("deviceId") || body?.deviceId);
  const appId = auth.app?.id || "";
  let claimed = claimTasks(limit, deviceId, appId);
  if (claimed.length === 0) {
    const waitMs = clamp(Number(url.searchParams.get("waitMs") || url.searchParams.get("timeoutMs") || workerTaskWaitMs), 0, 60000);
    await waitForClaimableTask(waitMs, appId);
    claimed = claimTasks(limit, deviceId, appId);
  }
  sendJson(res, 200, {
    code: 0,
    ok: true,
    status: claimed.length > 0 ? "claimed" : "empty",
    shouldContinue: true,
    tasks: claimed
  });
}

function handleTaskResult(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  const match = url.pathname.match(/^\/worker\/tasks\/([^/]+)\/result$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
  const taskBefore = findTaskOrThrow(taskId);
  if (!canAccessTask(auth, taskBefore)) return sendJson(res, 403, { code: -1, ok: false, message: "Forbidden" });
  const task = finishTask(taskId, body);
  sendJson(res, 200, { code: 0, ok: true, task: taskForResponse(task) });
}

function handleTaskMessagesAppend(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  const match = url.pathname.match(/^\/worker\/tasks\/([^/]+)\/messages$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
  const taskBefore = findTaskOrThrow(taskId);
  if (!canAccessTask(auth, taskBefore)) return sendJson(res, 403, { code: -1, ok: false, message: "Forbidden" });
  const result = appendTaskMessages(taskId, body, { finish: false });
  sendJson(res, 200, {
    code: 0,
    ok: true,
    status: result.task.status,
    task: taskForResponse(result.task),
    messages: result.messages.map(messageForResponse)
  });
}

function handleTaskFinish(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  const match = url.pathname.match(/^\/worker\/tasks\/([^/]+)\/finish$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
  const task = findTaskOrThrow(taskId);
  if (!canAccessTask(auth, task)) return sendJson(res, 403, { code: -1, ok: false, message: "Forbidden" });
  const finalText = extractText(body);
  const appended = finalText
    ? appendTaskMessages(taskId, { text: finalText, final: true, raw: body }, { finish: true, final: true })
    : { task, messages: [] };
  task.status = body?.ok === false || body?.status === "failed" ? "failed" : "done";
  task.updatedAt = Date.now();
  task.leaseUntil = 0;
  task.error = task.status === "failed" ? stringValue(body?.error || body?.reason || "RabiLink worker reported failure.") : "";
  finishWaiters(task);
  writeEvent(task.status === "done" ? "task_finished" : "task_failed", taskForResponse(task));
  sendJson(res, 200, {
    code: task.status === "done" ? 0 : -1,
    ok: task.status === "done",
    status: task.status,
    task: taskForResponse(task),
    messages: appended.messages.map(messageForResponse)
  });
}

function handleTaskRead(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  const match = url.pathname.match(/^\/worker\/tasks\/([^/]+)$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
  const task = tasks.get(taskId);
  if (!task) return sendJson(res, 404, { code: -1, ok: false, message: `Task not found: ${taskId}` });
  if (!canAccessTask(auth, task)) return sendJson(res, 403, { code: -1, ok: false, message: "Forbidden" });
  sendJson(res, 200, { code: 0, ok: true, task: taskForResponse(task) });
}

function adminPageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RabiLink Relay Admin</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f8f7;
      --panel: #ffffff;
      --ink: #17211d;
      --muted: #607069;
      --line: #d8e1dc;
      --brand: #107e6b;
      --brand-ink: #ffffff;
      --warn: #9a6700;
      --danger: #b42318;
      --soft: #edf5f2;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input, textarea { font: inherit; }
    .shell { width: min(1160px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 44px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
    .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .mark { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 8px; background: var(--brand); color: var(--brand-ink); font-weight: 800; }
    h1 { margin: 0; font-size: clamp(22px, 3vw, 32px); line-height: 1.1; letter-spacing: 0; }
    .subtitle { margin-top: 4px; color: var(--muted); font-size: 14px; }
    .grid { display: grid; grid-template-columns: minmax(280px, 380px) 1fr; gap: 16px; align-items: start; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; box-shadow: 0 12px 28px rgba(17, 37, 31, .05); }
    .card + .card { margin-top: 16px; }
    .title-row { display: flex; justify-content: space-between; gap: 12px; align-items: start; margin-bottom: 14px; }
    .title { font-size: 16px; font-weight: 760; }
    .note { color: var(--muted); font-size: 13px; line-height: 1.5; }
    label { display: grid; gap: 6px; color: #31443c; font-size: 13px; font-weight: 650; }
    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 11px 12px;
      background: #fbfdfc;
      color: var(--ink);
      outline: none;
    }
    textarea { min-height: 74px; resize: vertical; }
    input:focus, textarea:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(16, 126, 107, .12); }
    .form { display: grid; gap: 12px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    button {
      border: 0;
      border-radius: 8px;
      padding: 10px 13px;
      background: var(--soft);
      color: var(--brand);
      cursor: pointer;
      font-weight: 720;
    }
    button.primary { background: var(--brand); color: var(--brand-ink); }
    button.danger { background: #fff0ee; color: var(--danger); }
    button:disabled { opacity: .55; cursor: wait; }
    .status { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .pill { display: inline-flex; align-items: center; min-height: 30px; border-radius: 999px; padding: 5px 10px; background: var(--soft); color: var(--brand); font-size: 13px; font-weight: 700; }
    .pill.warn { background: #fff6df; color: var(--warn); }
    .alert { border-radius: 8px; padding: 11px 12px; margin-bottom: 14px; background: #fff0ee; color: var(--danger); border: 1px solid #ffd1ca; }
    .notice { border-radius: 8px; padding: 11px 12px; margin-bottom: 14px; background: var(--soft); color: var(--brand); border: 1px solid #cde5dc; }
    .app-list { display: grid; gap: 12px; }
    .app { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: #fbfdfc; }
    .app-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .app-name { font-weight: 780; }
    .app-id { color: var(--muted); font-size: 13px; word-break: break-all; }
    .meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 12px 0; }
    .tile { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #fff; min-width: 0; }
    .tile span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
    .tile b { display: block; min-height: 20px; overflow-wrap: anywhere; font-size: 13px; }
    .empty { padding: 28px; text-align: center; color: var(--muted); border: 1px dashed var(--line); border-radius: 8px; background: #fbfdfc; }
    .hidden { display: none !important; }
    @media (max-width: 820px) {
      .topbar { align-items: start; flex-direction: column; }
      .grid { grid-template-columns: 1fr; }
      .meta { grid-template-columns: 1fr; }
      .shell { width: min(100% - 20px, 1160px); padding-top: 18px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="topbar">
      <div class="brand">
        <div class="mark">Rb</div>
        <div>
          <h1>RabiLink Relay Admin</h1>
          <div class="subtitle">服务器侧账号、应用和 token 管理</div>
        </div>
      </div>
      <div class="actions">
        <button id="refreshButton">刷新</button>
        <button id="logoutButton" class="danger hidden">退出</button>
      </div>
    </div>

    <div id="alert" class="alert hidden"></div>
    <div id="notice" class="notice hidden"></div>
    <div class="status">
      <span id="setupPill" class="pill warn">等待初始化</span>
      <span id="accountPill" class="pill">未登录</span>
      <span id="countPill" class="pill">0 个应用</span>
    </div>

    <section class="grid">
      <div>
        <div id="loginCard" class="card">
          <div class="title-row">
            <div>
              <div id="authTitle" class="title">登录</div>
              <div id="authNote" class="note">使用服务器账号进入 RabiLink 应用管理。</div>
            </div>
          </div>
          <div class="form">
            <label>账号 <input id="username" autocomplete="username" /></label>
            <label>密码 <input id="password" type="password" autocomplete="current-password" /></label>
          </div>
          <div class="actions">
            <button id="loginButton" class="primary">登录</button>
            <button id="registerButton">注册账号</button>
          </div>
        </div>

        <div id="appCard" class="card hidden">
          <div class="title-row">
            <div>
              <div class="title">创建应用</div>
              <div class="note">为 Rokid、手机或调试入口生成独立 token。</div>
            </div>
          </div>
          <div class="form">
            <label>应用名称 <input id="appName" value="Rokid Glass" /></label>
            <label>备注 <textarea id="appNotes" placeholder="例如：生产眼镜、测试手机、家里局域网"></textarea></label>
          </div>
          <div class="actions">
            <button id="createAppButton" class="primary">创建应用</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="title-row">
          <div>
            <div class="title">应用列表</div>
            <div class="note">完整 token 只在创建或重新生成时显示；刷新后只保留预览。</div>
          </div>
        </div>
        <div id="apps" class="app-list"></div>
        <div id="empty" class="empty">还没有应用。先登录或完成首次注册，然后创建一个 RabiLink 应用。</div>
      </div>
    </section>
  </main>

  <script>
    const state = { account: null, apps: [], revealed: {}, credentials: loadCredentials(), setupRequired: false };
    const el = (id) => document.getElementById(id);

    function encodeAuth(username, password) {
      return btoa(unescape(encodeURIComponent(username + ":" + password)));
    }

    function loadCredentials() {
      try { return JSON.parse(localStorage.getItem("rabilinkAdminCredentials") || "null"); } catch { return null; }
    }

    function saveCredentials(username, password) {
      state.credentials = { username, auth: encodeAuth(username, password) };
      localStorage.setItem("rabilinkAdminCredentials", JSON.stringify(state.credentials));
    }

    function clearCredentials() {
      state.credentials = null;
      localStorage.removeItem("rabilinkAdminCredentials");
    }

    function headers(json) {
      const result = {};
      if (json) result["content-type"] = "application/json";
      if (state.credentials?.auth) result["x-rabilink-admin-auth"] = state.credentials.auth;
      return result;
    }

    async function request(path, options = {}) {
      const response = await fetch(path, { ...options, headers: { ...headers(Boolean(options.body)), ...(options.headers || {}) } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.code !== 0) throw new Error(body.message || body.error || "HTTP " + response.status);
      return body;
    }

    function flash(id, text) {
      const node = el(id);
      node.textContent = text || "";
      node.classList.toggle("hidden", !text);
    }

    function setBusy(button, busy) {
      button.disabled = Boolean(busy);
    }

    async function load() {
      flash("alert", "");
      try {
        const body = await request("/admin/api/state");
        state.account = body.account;
        state.apps = body.apps || [];
        state.setupRequired = Boolean(body.setupRequired);
      } catch (error) {
        state.account = null;
        state.apps = [];
        state.setupRequired = !state.credentials;
        if (state.credentials) flash("alert", error.message);
      }
      render();
    }

    async function login() {
      const username = el("username").value.trim();
      const password = el("password").value;
      setBusy(el("loginButton"), true);
      flash("alert", "");
      try {
        await request("/admin/api/login", {
          method: "POST",
          body: JSON.stringify({ username, password })
        });
        saveCredentials(username, password);
        el("password").value = "";
        flash("notice", "已登录。");
        await load();
      } catch (error) {
        flash("alert", error.message);
      } finally {
        setBusy(el("loginButton"), false);
      }
    }

    async function registerAccount() {
      const username = el("username").value.trim();
      const password = el("password").value;
      setBusy(el("registerButton"), true);
      flash("alert", "");
      try {
        await request("/admin/api/accounts", {
          method: "POST",
          body: JSON.stringify({ username, password })
        });
        saveCredentials(username, password);
        el("password").value = "";
        flash("notice", "账号已创建。");
        await load();
      } catch (error) {
        flash("alert", error.message);
      } finally {
        setBusy(el("registerButton"), false);
      }
    }

    async function createApp() {
      setBusy(el("createAppButton"), true);
      flash("alert", "");
      try {
        const body = await request("/admin/api/apps", {
          method: "POST",
          body: JSON.stringify({ name: el("appName").value, notes: el("appNotes").value })
        });
        if (body.app?.token) state.revealed[body.app.id] = body.app.token;
        el("appNotes").value = "";
        flash("notice", "应用已创建，token 仅本次显示。");
        await load();
      } catch (error) {
        flash("alert", error.message);
      } finally {
        setBusy(el("createAppButton"), false);
      }
    }

    async function patchApp(id, patch) {
      const body = await request("/admin/api/apps/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      if (body.app?.token) {
        state.revealed[body.app.id] = body.app.token;
        flash("notice", "token 已重新生成，旧 token 已失效。");
      }
      await load();
    }

    async function deleteApp(id, name) {
      if (!confirm("删除 RabiLink 应用「" + name + "」？")) return;
      await request("/admin/api/apps/" + encodeURIComponent(id), { method: "DELETE" });
      delete state.revealed[id];
      flash("notice", "应用已删除。");
      await load();
    }

    async function copyToken(id) {
      const token = state.revealed[id];
      if (!token) {
        flash("notice", "完整 token 只显示一次；需要查看请重新生成。");
        return;
      }
      await navigator.clipboard.writeText(token);
      flash("notice", "token 已复制。");
    }

    function render() {
      const loggedIn = Boolean(state.account);
      el("loginCard").classList.toggle("hidden", loggedIn && !state.setupRequired);
      el("appCard").classList.toggle("hidden", !loggedIn);
      el("logoutButton").classList.toggle("hidden", !state.credentials);
      el("setupPill").textContent = state.setupRequired ? "首次初始化" : "已初始化";
      el("setupPill").classList.toggle("warn", state.setupRequired);
      el("accountPill").textContent = state.account ? "账号：" + state.account.username : "未登录";
      el("countPill").textContent = state.apps.length + " 个应用";
      el("authTitle").textContent = state.setupRequired ? "首次注册" : "登录";
      el("authNote").textContent = state.setupRequired ? "创建服务器上的第一个管理账号。" : "使用服务器账号进入 RabiLink 应用管理。";
      el("registerButton").textContent = state.setupRequired ? "创建第一个账号" : "新增账号";

      const container = el("apps");
      container.innerHTML = "";
      el("empty").classList.toggle("hidden", state.apps.length > 0);
      for (const app of state.apps) {
        const token = state.revealed[app.id] || app.tokenPreview || "";
        const node = document.createElement("div");
        node.className = "app";
        node.innerHTML =
          '<div class="app-head">' +
            '<div><div class="app-name"></div><div class="app-id"></div></div>' +
            '<label style="display:flex;align-items:center;gap:8px;font-weight:700;"><input class="enabled" type="checkbox" style="width:auto;">启用</label>' +
          '</div>' +
          '<div class="meta">' +
            '<div class="tile"><span>Token</span><b class="token"></b></div>' +
            '<div class="tile"><span>备注</span><b class="notes"></b></div>' +
            '<div class="tile"><span>更新时间</span><b class="updated"></b></div>' +
          '</div>' +
          '<div class="actions">' +
            '<button class="copy">复制 token</button>' +
            '<button class="regen">重新生成 token</button>' +
            '<button class="danger delete">删除</button>' +
          '</div>';
        node.querySelector(".app-name").textContent = app.name;
        node.querySelector(".app-id").textContent = app.id;
        node.querySelector(".enabled").checked = app.enabled !== false;
        node.querySelector(".token").textContent = token;
        node.querySelector(".notes").textContent = app.notes || "-";
        node.querySelector(".updated").textContent = app.updatedAt || "-";
        node.querySelector(".enabled").addEventListener("change", (event) => patchApp(app.id, { enabled: event.target.checked }).catch((error) => flash("alert", error.message)));
        node.querySelector(".copy").addEventListener("click", () => copyToken(app.id));
        node.querySelector(".regen").addEventListener("click", () => patchApp(app.id, { regenerateToken: true }).catch((error) => flash("alert", error.message)));
        node.querySelector(".delete").addEventListener("click", () => deleteApp(app.id, app.name).catch((error) => flash("alert", error.message)));
        container.appendChild(node);
      }
    }

    el("refreshButton").addEventListener("click", load);
    el("loginButton").addEventListener("click", login);
    el("registerButton").addEventListener("click", registerAccount);
    el("createAppButton").addEventListener("click", createApp);
    el("logoutButton").addEventListener("click", () => { clearCredentials(); state.account = null; state.apps = []; flash("notice", "已退出。"); render(); });
    load();
  </script>
</body>
</html>`;
}

async function handleAdminApi(req, url, res) {
  const body = req.method === "GET" ? {} : await readBody(req);
  if (req.method === "GET" && url.pathname === "/admin/api/state") {
    const auth = authorizeAdmin(req, url, body);
    if (!auth.ok && !auth.setupRequired) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
    return sendJson(res, 200, accountStorePayload(auth.account));
  }
  if (req.method === "POST" && url.pathname === "/admin/api/login") {
    const account = loginAccount(body);
    return sendJson(res, 200, { code: 0, ok: true, account: publicAccount(account) });
  }
  if (req.method === "POST" && url.pathname === "/admin/api/accounts") {
    const store = readAppStore();
    if (store.accounts.length > 0) {
      const auth = authorizeAdmin(req, url, body);
      if (!auth.ok) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
    }
    const account = createAccount(body);
    return sendJson(res, 200, { code: 0, ok: true, account: publicAccount(account) });
  }
  const auth = authorizeAdmin(req, url, body);
  if (!auth.ok) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  if (req.method === "POST" && url.pathname === "/admin/api/apps") {
    const app = createAppForAccount(auth.account, body);
    return sendJson(res, 200, { code: 0, ok: true, app: publicApp(app, { revealToken: true }) });
  }
  const appMatch = url.pathname.match(/^\/admin\/api\/apps\/([^/]+)$/);
  if (appMatch && req.method === "PATCH") {
    const { app, revealToken } = patchOwnedApp(auth.account, decodeURIComponent(appMatch[1]), body);
    return sendJson(res, 200, { code: 0, ok: true, app: publicApp(app, { revealToken }) });
  }
  if (appMatch && req.method === "DELETE") {
    deleteOwnedApp(auth.account, decodeURIComponent(appMatch[1]));
    return sendJson(res, 200, { code: 0, ok: true });
  }
  return sendJson(res, 404, { code: -1, ok: false, message: "Not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      return sendHtml(res, adminPageHtml());
    }
    if (url.pathname.startsWith("/admin/api/")) {
      return await handleAdminApi(req, url, res);
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      cleanupTasks();
      const store = readAppStore();
      return sendJson(res, 200, {
        code: 0,
        ok: true,
        name: "RabiLink Relay",
        time: nowIso(),
        admin: {
          url: "/admin",
          accounts: store.accounts.length,
          apps: store.apps.length,
          enabledApps: store.apps.filter((app) => app.enabled !== false).length,
          legacyToken: Boolean(legacyToken)
        },
        queue: {
          total: tasks.size,
          queued: [...tasks.values()].filter((task) => task.status === "queued").length,
          leased: [...tasks.values()].filter((task) => task.status === "leased").length
        }
      });
    }
    if (req.method === "GET" && (url.pathname === "/rokid/rabilink/openapi.json" || url.pathname === "/openapi/rokid-rabilink-plugin.json")) {
      return sendOpenApi(res);
    }
    if (req.method === "GET" && (url.pathname === "/rokid/rabilink/openapi.manual-auth.json" || url.pathname === "/openapi/rokid-rabilink-plugin.manual-auth.json")) {
      return sendOpenApi(res, manualAuthOpenApiFileCandidates);
    }
    if (req.method === "GET" && (url.pathname === "/rokid/rabilink/tools.postman.json" || url.pathname === "/openapi/rokid-rabilink-tools.postman.json")) {
      return sendOpenApi(res, toolImportPostmanFileCandidates);
    }
    const body = req.method === "GET" ? {} : await readBody(req);
    if (req.method === "POST" && (url.pathname === "/rokid/rabilink" || url.pathname === "/api/rokid/rabilink")) {
      return await handleRokid(req, url, res, body);
    }
    if (req.method === "POST" && (url.pathname === "/rokid/rabilink/tasks" || url.pathname === "/api/rokid/rabilink/tasks")) {
      return handleRokidCreateTask(req, url, res, body);
    }
    if (req.method === "GET" && /^\/rokid\/rabilink\/tasks\/[^/]+$/.test(url.pathname)) {
      return handleRokidTaskRead(req, url, res, body);
    }
    if (req.method === "GET" && /^\/rokid\/rabilink\/tasks\/[^/]+\/messages$/.test(url.pathname)) {
      return await handleRokidTaskMessages(req, url, res, body);
    }
    if (req.method === "GET" && (url.pathname === "/rokid/rabilink/messages" || url.pathname === "/api/rokid/rabilink/messages")) {
      return await handleRokidOutboxMessages(req, url, res, body);
    }
    if (req.method === "GET" && url.pathname === "/worker/tasks") {
      return await handleWorkerTasks(req, url, res, body);
    }
    if (req.method === "POST" && /^\/worker\/tasks\/[^/]+\/messages$/.test(url.pathname)) {
      return handleTaskMessagesAppend(req, url, res, body);
    }
    if (req.method === "POST" && /^\/worker\/tasks\/[^/]+\/finish$/.test(url.pathname)) {
      return handleTaskFinish(req, url, res, body);
    }
    if (req.method === "POST" && /^\/worker\/tasks\/[^/]+\/result$/.test(url.pathname)) {
      return handleTaskResult(req, url, res, body);
    }
    if (req.method === "GET" && /^\/worker\/tasks\/[^/]+$/.test(url.pathname)) {
      return handleTaskRead(req, url, res, body);
    }
    return sendJson(res, 404, { code: -1, ok: false, message: "Not found" });
  } catch (error) {
    const statusCode = Number(error.statusCode || 500);
    const message = error instanceof Error ? error.message : String(error);
    writeEvent("request_error", { path: url.pathname, message });
    return sendJson(res, statusCode, { code: -1, ok: false, message });
  }
});

server.listen(port, host, () => {
  console.log(`RabiLink Relay listening on http://${host}:${port}`);
  console.log(`Data dir: ${dataDir}`);
});
