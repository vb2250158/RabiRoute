#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

const port = Number(process.env.PORT || process.env.RABILINK_RELAY_PORT || 8788);
const host = process.env.HOST || process.env.RABILINK_RELAY_HOST || "0.0.0.0";
const legacyToken = process.env.RABILINK_RELAY_TOKEN || "";
const replyTimeoutMs = clamp(Number(process.env.RABILINK_RELAY_REPLY_TIMEOUT_MS || 60000), 1000, 120000);
const messageWaitMs = clamp(Number(process.env.RABILINK_RELAY_MESSAGE_WAIT_MS || 60000), 0, 60000);
const outboxWaitMs = clamp(Number(process.env.RABILINK_RELAY_OUTBOX_WAIT_MS || 60000), 0, 60000);
const workerTaskWaitMs = clamp(Number(process.env.RABILINK_RELAY_WORKER_TASK_WAIT_MS || 60000), 0, 60000);
const webguiRequestWaitMs = clamp(Number(process.env.RABILINK_RELAY_WEBGUI_REQUEST_WAIT_MS || 30000), 5000, 120000);
const webguiBodyMaxBytes = clamp(Number(process.env.RABILINK_RELAY_WEBGUI_BODY_MAX_BYTES || 10 * 1024 * 1024), 1024 * 1024, 50 * 1024 * 1024);
const taskTtlMs = clamp(Number(process.env.RABILINK_RELAY_TASK_TTL_MS || 10 * 60 * 1000), 60000, 24 * 60 * 60 * 1000);
const leaseMs = clamp(Number(process.env.RABILINK_RELAY_LEASE_MS || 45000), 5000, 10 * 60 * 1000);
const dataDir = path.resolve(process.env.RABILINK_RELAY_DATA_DIR || path.join(process.cwd(), "data", "rabilink-relay"));
const eventLogPath = path.join(dataDir, "events.jsonl");
const appStorePath = path.resolve(process.env.RABILINK_RELAY_APP_STORE_FILE || path.join(dataDir, "apps.json"));
const webguiDistPath = path.resolve(process.env.RABILINK_RELAY_WEBGUI_DIST_DIR || path.join(process.cwd(), "ribiwebgui", "dist"));
const webguiAssetPath = path.resolve(process.env.RABILINK_RELAY_WEBGUI_ASSET_DIR || path.join(process.cwd(), "assets"));
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
const agentTokenOpenApiFileCandidates = [
  process.env.RABILINK_RELAY_AGENT_TOKEN_OPENAPI_FILE ? path.resolve(process.env.RABILINK_RELAY_AGENT_TOKEN_OPENAPI_FILE) : "",
  path.join(dataDir, "rokid-rabilink-plugin.AGENT_TOKEN.openapi.json"),
  path.join(process.cwd(), "rokid-rabilink-plugin.AGENT_TOKEN.openapi.json")
].filter(Boolean);
const toolImportPostmanFileCandidates = [
  process.env.RABILINK_RELAY_TOOL_IMPORT_POSTMAN_FILE ? path.resolve(process.env.RABILINK_RELAY_TOOL_IMPORT_POSTMAN_FILE) : "",
  path.join(dataDir, "rokid-rabilink-tools-import.CURRENT.postman.json"),
  path.join(process.cwd(), "rokid-rabilink-tools-import.CURRENT.postman.json")
].filter(Boolean);

fs.mkdirSync(dataDir, { recursive: true });
if (!hasEnabledRabiLinkApps()) {
  console.warn("No enabled RabiLink app tokens exist yet. Open /manage to create the first account and app token.");
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
/** @type {Map<string, RelayWebguiRequest>} */
const webguiRequests = new Map();
/** @type {Array<{ resolve: () => void; timer: NodeJS.Timeout }>} */
const webguiRequestWaiters = [];
/** @type {Map<string, ManageSession>} */
const manageSessions = new Map();

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
 * @property {string} targetDeviceId
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

/**
 * @typedef {object} RelayWorker
 * @property {string} id
 * @property {string} guid
 * @property {string} name
 * @property {string} appId
 * @property {string} firstSeenAt
 * @property {string} lastSeenAt
 */

/**
 * @typedef {object} RelayWebguiRequest
 * @property {string} id
 * @property {string} status
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} expiresAt
 * @property {number} leaseUntil
 * @property {number} attempts
 * @property {string} appId
 * @property {string} appName
 * @property {string} targetDeviceId
 * @property {string} method
 * @property {string} path
 * @property {Record<string, string>} headers
 * @property {string} bodyBase64
 * @property {RelayWebguiResponse | null} response
 * @property {string} [error]
 */

/**
 * @typedef {object} RelayWebguiResponse
 * @property {number} statusCode
 * @property {Record<string, string>} headers
 * @property {string} bodyBase64
 */

/**
 * @typedef {object} ManageSession
 * @property {string} token
 * @property {string} accountId
 * @property {string} username
 * @property {number} expiresAt
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

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const split = part.indexOf("=");
      if (split < 0) return [part, ""];
      return [part.slice(0, split), decodeURIComponent(part.slice(split + 1))];
    }));
}

function cleanupManageSessions(now = Date.now()) {
  for (const [token, session] of manageSessions.entries()) {
    if (session.expiresAt <= now) manageSessions.delete(token);
  }
}

function createManageSession(account) {
  cleanupManageSessions();
  const token = randomBytes(32).toString("base64url");
  const session = {
    token,
    accountId: account.id,
    username: account.username,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
  };
  manageSessions.set(token, session);
  return session;
}

function manageSessionCookie(session) {
  return `rabilink_manage_session=${encodeURIComponent(session.token)}; Path=/manage; HttpOnly; SameSite=Lax; Max-Age=604800`;
}

function clearManageSessionCookie() {
  return "rabilink_manage_session=; Path=/manage; HttpOnly; SameSite=Lax; Max-Age=0";
}

function accountFromManageSession(req) {
  cleanupManageSessions();
  const token = parseCookies(req).rabilink_manage_session || "";
  if (!token) return null;
  const session = manageSessions.get(token);
  if (!session) return null;
  const account = readAppStore().accounts.find((item) => item.id === session.accountId);
  if (!account) {
    manageSessions.delete(token);
    return null;
  }
  return account;
}

function sanitizeRabiLinkId(value, fallback) {
  const raw = String(value || "").trim();
  return raw.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "") || fallback;
}

function normalizeStoredWorker(worker) {
  const id = String(worker?.id || "").trim();
  if (!id) return null;
  const time = String(worker?.lastSeenAt || worker?.firstSeenAt || nowIso());
  return {
    id,
    guid: String(worker?.guid || "").trim(),
    name: String(worker?.name || id).trim() || id,
    appId: String(worker?.appId || "").trim(),
    firstSeenAt: String(worker?.firstSeenAt || time),
    lastSeenAt: String(worker?.lastSeenAt || time)
  };
}

function readAppStore() {
  if (!fs.existsSync(appStorePath)) {
    return { accounts: [], apps: [], workers: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(appStorePath, "utf8"));
    return {
      accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
      apps: Array.isArray(raw.apps)
        ? raw.apps.map((app) => ({
          ...app,
          enabled: app.enabled !== false,
          tokenPreview: app.tokenPreview || rabiLinkTokenPreview(app.token),
          targetDeviceId: String(app.targetDeviceId || "").trim()
        }))
        : [],
      workers: Array.isArray(raw.workers) ? raw.workers.map(normalizeStoredWorker).filter(Boolean) : []
    };
  } catch (error) {
    writeEvent("app_store_read_failed", { path: appStorePath, message: error instanceof Error ? error.message : String(error) });
    return { accounts: [], apps: [], workers: [] };
  }
}

function writeAppStore(store) {
  fs.mkdirSync(path.dirname(appStorePath), { recursive: true });
  fs.writeFileSync(appStorePath, JSON.stringify({
    accounts: store.accounts,
    apps: store.apps,
    workers: store.workers || []
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

function workerOnline(worker) {
  const lastSeenMs = Date.parse(worker?.lastSeenAt || "");
  if (!Number.isFinite(lastSeenMs)) return false;
  return Date.now() - lastSeenMs <= Math.max(workerTaskWaitMs * 2, 120000);
}

function selectedWorkerForApp(app) {
  const targetDeviceId = stringValue(app?.targetDeviceId);
  if (!app || !targetDeviceId) return null;
  return readAppStore().workers.find((worker) => worker.appId === app.id
    && (worker.id === targetDeviceId || worker.guid === targetDeviceId)) || null;
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
    targetDeviceId: app.targetDeviceId || "",
    createdAt: app.createdAt,
    updatedAt: app.updatedAt
  };
}

function publicWorker(worker, app) {
  const appTokenPreview = app ? app.tokenPreview || rabiLinkTokenPreview(app.token) : "";
  return {
    id: worker.id,
    guid: worker.guid || "",
    name: worker.name || worker.id,
    appId: worker.appId || "",
    appName: app?.name || "",
    appTokenPreview,
    firstSeenAt: worker.firstSeenAt || "",
    lastSeenAt: worker.lastSeenAt || "",
    online: workerOnline(worker)
  };
}

function accountStorePayload(account, options = {}) {
  const store = readAppStore();
  const apps = account
    ? store.apps.filter((app) => app.ownerAccountId === account.id)
    : [];
  const appsById = new Map(apps.map((app) => [app.id, app]));
  const workers = store.workers.filter((worker) => appsById.has(worker.appId));
  return {
    code: 0,
    ok: true,
    setupRequired: store.accounts.length === 0,
    account: account ? publicAccount(account) : null,
    apps: apps.map((app) => publicApp(app, { revealToken: true })),
    workers: workers.map((worker) => publicWorker(worker, appsById.get(worker.appId))),
    dataPath: path.relative(process.cwd(), appStorePath).replace(/\\/g, "/")
  };
}

function recordWorkerSeen(appId, deviceId, deviceName, deviceGuid = "") {
  const id = sanitizeRabiLinkId(deviceId || deviceName, "rabi-pc");
  if (!id) return null;
  const guid = stringValue(deviceGuid);
  const store = readAppStore();
  const time = nowIso();
  const name = stringValue(deviceName || id) || id;
  let worker = store.workers.find((item) => item.appId === appId && (item.id === id || (guid && item.guid === guid)));
  if (worker) {
    worker.id = worker.id || id;
    worker.guid = guid || worker.guid || "";
    worker.name = name;
    worker.lastSeenAt = time;
  } else {
    worker = {
      id,
      guid,
      name,
      appId,
      firstSeenAt: time,
      lastSeenAt: time
    };
    store.workers.push(worker);
  }
  writeAppStore(store);
  return worker;
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
  if (credentials.username || credentials.password) {
    const account = store.accounts.find((item) => item.username.toLowerCase() === credentials.username.toLowerCase());
    if (!account || !verifyPassword(credentials.password, account)) {
      return { ok: false, setupRequired: false, account: null };
    }
    return { ok: true, setupRequired: false, account };
  }
  const sessionAccount = accountFromManageSession(req);
  if (sessionAccount) return { ok: true, setupRequired: false, account: sessionAccount };
  return { ok: false, setupRequired: false, account: null };
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
    targetDeviceId: String(body.targetDeviceId || "").trim(),
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
  if (body.targetDeviceId !== undefined) app.targetDeviceId = String(body.targetDeviceId || "").trim();
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
  store.workers = (store.workers || []).filter((worker) => worker.appId !== removed.id);
  writeAppStore(store);
  writeEvent("admin_app_deleted", { app: publicApp(removed) });
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-rabilink-token,x-rabilink-admin-auth",
    ...extraHeaders
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

function redirect(res, location, statusCode = 302) {
  res.writeHead(statusCode, {
    location,
    "cache-control": "no-store"
  });
  res.end();
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*"
  });
  res.end(text);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > webguiBodyMaxBytes) {
        reject(Object.assign(new Error("WebGUI request body is too large."), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
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
  const app = findEnabledAppByToken(requestTokenValue);
  if (app) {
    return { ok: true, app, legacy: false, insecure: false };
  }
  if (legacyToken && requestTokenValue === legacyToken) {
    return {
      ok: false,
      app: null,
      legacy: true,
      insecure: false,
      statusCode: 401,
      message: "旧版公共 token 已停用。请在 RabiLink服务器控制台复制对应应用 token，并让灵珠插件和 PC Rabi 使用同一个应用 token。"
    };
  }
  return { ok: false, app: null, legacy: false, insecure: false };
}

function sendRabiLinkAuthError(res, auth) {
  return sendRabiLinkError(res, auth.statusCode || 401, auth.message || "Unauthorized");
}

function sendRabiLinkError(res, statusCode, message) {
  return sendJson(res, statusCode, {
    code: -1,
    ok: false,
    status: "failed",
    done: true,
    shouldContinue: false,
    message,
    text: message,
    answer: message,
    reply: message,
    content: message
  });
}

function requireRokidAppTarget(auth) {
  if (!auth.app) {
    const error = new Error("请使用 RabiLink服务器控制台里对应应用的 token。");
    error.statusCode = 401;
    throw error;
  }
  if (!auth.app.targetDeviceId) {
    const error = new Error("这个 RabiLink 应用还没有选择要通讯的 Rabi PC。请先在 RabiLink服务器控制台为该应用选择一台已连接的 Rabi PC。");
    error.statusCode = 409;
    throw error;
  }
  const worker = selectedWorkerForApp(auth.app);
  if (!worker) {
    const error = new Error(`找不到这个应用绑定的 Rabi PC：${auth.app.targetDeviceId}`);
    error.statusCode = 409;
    throw error;
  }
  if (!workerOnline(worker)) {
    const error = new Error(`这个应用绑定的 Rabi PC 当前未连接：${worker.name || worker.id}`);
    error.statusCode = 503;
    throw error;
  }
  return worker;
}

function canAccessTask(auth, task) {
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
    targetDeviceId: task.targetDeviceId || "",
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
    targetDeviceId: auth.app?.targetDeviceId || "",
    source: {
      userAgent: String(req.headers["user-agent"] || ""),
      ip: String(req.socket.remoteAddress || ""),
      rokidRequestId: stringValue(raw?.requestId || raw?.id || raw?.messageId),
      sender: stringValue(raw?.sender || raw?.user || raw?.deviceId),
      appId: auth.app?.id || "",
      appName: auth.app?.name || "",
      targetDeviceId: auth.app?.targetDeviceId || ""
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

function webguiRequestForResponse(request) {
  return {
    id: request.id,
    status: request.status,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    expiresAt: request.expiresAt,
    attempts: request.attempts,
    appId: request.appId || "",
    appName: request.appName || "",
    targetDeviceId: request.targetDeviceId || "",
    method: request.method,
    path: request.path,
    headers: request.headers,
    bodyBase64: request.bodyBase64 || "",
    error: request.error || ""
  };
}

function cleanupWebguiRequests(now = Date.now()) {
  for (const [id, request] of webguiRequests.entries()) {
    if (request.status !== "done" && request.status !== "failed" && request.expiresAt <= now) {
      request.status = "failed";
      request.updatedAt = now;
      request.error = "WebGUI request timed out before the Rabi PC returned a response.";
      finishWebguiWaiters(request);
      writeEvent("webgui_request_expired", webguiRequestForResponse(request));
    }
    if ((request.status === "done" || request.status === "failed") && request.updatedAt + taskTtlMs <= now) {
      webguiRequests.delete(id);
    }
  }
}

function canWorkerClaimWebguiRequest(request, appId = "", deviceId = "") {
  if (appId && request.appId !== appId) return false;
  if (request.targetDeviceId && request.targetDeviceId !== deviceId) return false;
  return true;
}

function hasClaimableWebguiRequests(appId = "", deviceId = "") {
  cleanupWebguiRequests();
  const now = Date.now();
  for (const request of webguiRequests.values()) {
    if (!canWorkerClaimWebguiRequest(request, appId, deviceId)) continue;
    if (request.status === "queued") return true;
    if (request.status === "leased" && request.leaseUntil <= now) return true;
  }
  return false;
}

function claimWebguiRequests(limit, deviceId, appId = "") {
  cleanupWebguiRequests();
  const now = Date.now();
  const result = [];
  for (const request of webguiRequests.values()) {
    if (result.length >= limit) break;
    if (!canWorkerClaimWebguiRequest(request, appId, deviceId)) continue;
    if (request.status === "leased" && request.leaseUntil <= now) {
      request.status = "queued";
      request.leaseUntil = 0;
    }
    if (request.status !== "queued") continue;
    request.status = "leased";
    request.updatedAt = now;
    request.leaseUntil = now + leaseMs;
    request.attempts += 1;
    result.push(webguiRequestForResponse(request));
    writeEvent("webgui_request_leased", webguiRequestForResponse(request));
  }
  return result;
}

function notifyWebguiRequestWaiters() {
  for (let index = webguiRequestWaiters.length - 1; index >= 0; index -= 1) {
    const waiter = webguiRequestWaiters[index];
    clearTimeout(waiter.timer);
    webguiRequestWaiters.splice(index, 1);
    waiter.resolve();
  }
}

function waitForClaimableWebguiRequest(timeoutMs, appId = "", deviceId = "") {
  if (hasClaimableWebguiRequests(appId, deviceId) || timeoutMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = webguiRequestWaiters.findIndex((item) => item.resolve === resolve);
      if (index >= 0) webguiRequestWaiters.splice(index, 1);
      resolve();
    }, timeoutMs);
    webguiRequestWaiters.push({ resolve, timer });
  });
}

function finishWebguiWaiters(request) {
  for (let index = waiters.length - 1; index >= 0; index -= 1) {
    const waiter = waiters[index];
    if (waiter.taskId !== request.id) continue;
    clearTimeout(waiter.timer);
    waiters.splice(index, 1);
    waiter.resolve(request);
  }
}

function waitForWebguiRequest(request, timeoutMs) {
  if (request.status === "done" || request.status === "failed") return Promise.resolve(request);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = waiters.findIndex((item) => item.taskId === request.id && item.resolve === resolve);
      if (index >= 0) waiters.splice(index, 1);
      resolve(request);
    }, timeoutMs);
    waiters.push({ taskId: request.id, resolve, timer });
  });
}

function finishWebguiRequest(requestId, body) {
  const request = webguiRequests.get(requestId);
  if (!request) {
    const error = new Error(`WebGUI request not found: ${requestId}`);
    error.statusCode = 404;
    throw error;
  }
  const ok = body?.ok !== false && Number(body?.statusCode || 0) >= 100;
  request.status = ok ? "done" : "failed";
  request.updatedAt = Date.now();
  request.leaseUntil = 0;
  request.response = ok
    ? {
      statusCode: clamp(Number(body.statusCode || 200), 100, 599),
      headers: normalizeProxyResponseHeaders(body.headers),
      bodyBase64: stringValue(body.bodyBase64)
    }
    : null;
  request.error = ok ? "" : stringValue(body?.error || "Rabi PC failed to proxy WebGUI request.");
  finishWebguiWaiters(request);
  writeEvent(ok ? "webgui_request_done" : "webgui_request_failed", webguiRequestForResponse(request));
  return request;
}

function normalizeProxyRequestHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (!["accept", "content-type", "user-agent"].includes(lower)) continue;
    result[lower] = Array.isArray(value) ? value.join(", ") : String(value || "");
  }
  return result;
}

function normalizeProxyResponseHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (["connection", "content-length", "content-encoding", "transfer-encoding", "keep-alive", "set-cookie"].includes(lower)) continue;
    result[lower] = Array.isArray(value) ? value.join(", ") : String(value || "");
  }
  return result;
}

function createWebguiRequest(req, target, localPath, rawBody) {
  const now = Date.now();
  const request = {
    id: `rabilink-webgui-${now}-${randomUUID().slice(0, 8)}`,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + webguiRequestWaitMs,
    leaseUntil: 0,
    attempts: 0,
    appId: target.app.id,
    appName: target.app.name || "",
    targetDeviceId: target.worker.id,
    method: String(req.method || "GET").toUpperCase(),
    path: localPath,
    headers: normalizeProxyRequestHeaders(req.headers),
    bodyBase64: Buffer.isBuffer(rawBody) && rawBody.length > 0 ? rawBody.toString("base64") : "",
    response: null
  };
  webguiRequests.set(request.id, request);
  writeEvent("webgui_request_created", webguiRequestForResponse(request));
  notifyWebguiRequestWaiters();
  return request;
}

function createMobileWebguiRequest(app, worker, method, localPath, body = null) {
  const now = Date.now();
  const bodyBuffer = body == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
  const request = {
    id: `rabilink-webgui-${now}-${randomUUID().slice(0, 8)}`,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + webguiRequestWaitMs,
    leaseUntil: 0,
    attempts: 0,
    appId: app.id,
    appName: app.name || "",
    targetDeviceId: worker.id,
    method: String(method || "GET").toUpperCase(),
    path: localPath,
    headers: {
      accept: "application/json",
      ...(body == null ? {} : { "content-type": "application/json; charset=utf-8" })
    },
    bodyBase64: bodyBuffer.length > 0 ? bodyBuffer.toString("base64") : "",
    response: null
  };
  webguiRequests.set(request.id, request);
  writeEvent("webgui_request_created", webguiRequestForResponse(request));
  notifyWebguiRequestWaiters();
  return request;
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
  cleanupWebguiRequests(now);
}

function cleanupOutboxMessages(now = Date.now()) {
  const firstLiveIndex = outboxMessages.findIndex((message) => message.createdAt + taskTtlMs > now);
  if (firstLiveIndex > 0) {
    outboxMessages.splice(0, firstLiveIndex);
  } else if (firstLiveIndex < 0 && outboxMessages.length > 0) {
    outboxMessages.splice(0, outboxMessages.length);
  }
}

function canWorkerClaimTask(task, appId = "", deviceId = "") {
  if (appId && task.appId !== appId) return false;
  if (task.targetDeviceId && task.targetDeviceId !== deviceId) return false;
  return true;
}

function claimTasks(limit, deviceId, appId = "") {
  cleanupTasks();
  const now = Date.now();
  const result = [];
  for (const task of tasks.values()) {
    if (result.length >= limit) break;
    if (!canWorkerClaimTask(task, appId, deviceId)) continue;
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

function hasClaimableTasks(appId = "", deviceId = "") {
  cleanupTasks();
  const now = Date.now();
  for (const task of tasks.values()) {
    if (!canWorkerClaimTask(task, appId, deviceId)) continue;
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

function waitForClaimableTask(timeoutMs, appId = "", deviceId = "") {
  if (hasClaimableTasks(appId, deviceId) || timeoutMs <= 0) return Promise.resolve();
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
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  requireRokidAppTarget(auth);
  const task = createTask(body, req, auth);
  const wait = url.searchParams.get("wait");
  const shouldWait = wait == null || wait === "1" || wait.toLowerCase() === "true";
  const timeout = clamp(Number(url.searchParams.get("timeoutMs") || replyTimeoutMs), 1000, 120000);
  const finalTask = shouldWait ? await waitForTask(task, timeout) : task;
  sendJson(res, 200, rokidResponse(finalTask));
}

function handleRokidCreateTask(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  requireRokidAppTarget(auth);
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
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
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
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
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
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
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
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const limit = clamp(Number(url.searchParams.get("limit") || 1), 1, 10);
  const deviceId = stringValue(url.searchParams.get("deviceId") || body?.deviceId);
  const deviceName = stringValue(url.searchParams.get("deviceName") || body?.deviceName || deviceId);
  const deviceGuid = stringValue(url.searchParams.get("deviceGuid") || body?.deviceGuid);
  const appId = auth.app?.id || "";
  if (deviceId || deviceName) {
    recordWorkerSeen(appId, deviceId || deviceName, deviceName || deviceId, deviceGuid);
  }
  let claimed = claimTasks(limit, deviceId, appId);
  if (claimed.length === 0) {
    const waitMs = clamp(Number(url.searchParams.get("waitMs") || url.searchParams.get("timeoutMs") || workerTaskWaitMs), 0, 60000);
    await waitForClaimableTask(waitMs, appId, deviceId);
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

async function handleWorkerWebguiRequests(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const limit = clamp(Number(url.searchParams.get("limit") || 1), 1, 5);
  const deviceId = stringValue(url.searchParams.get("deviceId") || body?.deviceId);
  const deviceName = stringValue(url.searchParams.get("deviceName") || body?.deviceName || deviceId);
  const deviceGuid = stringValue(url.searchParams.get("deviceGuid") || body?.deviceGuid);
  const appId = auth.app?.id || "";
  if (deviceId || deviceName) {
    recordWorkerSeen(appId, deviceId || deviceName, deviceName || deviceId, deviceGuid);
  }
  let claimed = claimWebguiRequests(limit, deviceId, appId);
  if (claimed.length === 0) {
    const waitMs = clamp(Number(url.searchParams.get("waitMs") || url.searchParams.get("timeoutMs") || workerTaskWaitMs), 0, 60000);
    await waitForClaimableWebguiRequest(waitMs, appId, deviceId);
    claimed = claimWebguiRequests(limit, deviceId, appId);
  }
  sendJson(res, 200, {
    code: 0,
    ok: true,
    status: claimed.length > 0 ? "claimed" : "empty",
    shouldContinue: true,
    requests: claimed
  });
}

function handleWorkerWebguiResponse(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const match = url.pathname.match(/^\/worker\/webgui-requests\/([^/]+)\/response$/);
  const requestId = match ? decodeURIComponent(match[1]) : "";
  const request = webguiRequests.get(requestId);
  if (!request) return sendJson(res, 404, { code: -1, ok: false, message: `WebGUI request not found: ${requestId}` });
  if (auth.app?.id !== request.appId) {
    return sendJson(res, 403, { code: -1, ok: false, message: "Forbidden" });
  }
  const finished = finishWebguiRequest(requestId, body);
  sendJson(res, 200, { code: 0, ok: true, request: webguiRequestForResponse(finished) });
}

function handleTaskResult(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  const match = url.pathname.match(/^\/worker\/tasks\/([^/]+)\/result$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
  const taskBefore = findTaskOrThrow(taskId);
  if (!canAccessTask(auth, taskBefore)) return sendJson(res, 403, { code: -1, ok: false, message: "Forbidden" });
  const task = finishTask(taskId, body);
  sendJson(res, 200, { code: 0, ok: true, task: taskForResponse(task) });
}

function handleTaskMessagesAppend(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
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
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
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
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
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
  <title>RabiLink服务器控制台</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f8fb;
      --panel: #ffffff;
      --ink: #112033;
      --title: #0c2a4a;
      --muted: #667586;
      --line: rgba(17, 32, 51, .1);
      --brand: #102a43;
      --accent: #19bfc1;
      --brand-ink: #ffffff;
      --warn: #9a6700;
      --danger: #dc2626;
      --soft: rgba(25, 191, 193, .12);
      --field: rgba(255, 255, 255, .86);
      --field-hover: rgba(236, 252, 255, .74);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(90deg, rgba(12, 42, 74, .04) 1px, transparent 1px),
        linear-gradient(0deg, rgba(12, 42, 74, .032) 1px, transparent 1px),
        linear-gradient(180deg, #fbfdff 0%, #f2f8fa 52%, #f8fbfd 100%);
      background-size: 40px 40px, 40px 40px, auto;
      color: var(--ink);
      font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;
    }
    button, input, textarea { font: inherit; }
    .shell { width: min(1160px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 44px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
    .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .mark { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 8px; background: linear-gradient(135deg, var(--brand), #0f8b8d); color: var(--brand-ink); font-weight: 900; }
    h1 { margin: 0; font-size: clamp(22px, 3vw, 32px); line-height: 1.1; letter-spacing: 0; }
    .subtitle { margin-top: 4px; color: var(--muted); font-size: 14px; }
    .grid { display: grid; grid-template-columns: minmax(280px, 380px) 1fr; gap: 16px; align-items: start; }
    .card { background: rgba(255, 255, 255, .92); border: 1px solid var(--line); border-radius: 8px; padding: 18px; box-shadow: 0 10px 24px rgba(15, 23, 42, .07); backdrop-filter: blur(14px); }
    .card + .card { margin-top: 16px; }
    .title-row { display: flex; justify-content: space-between; gap: 12px; align-items: start; margin-bottom: 14px; }
    .title { color: var(--title); font-size: 16px; font-weight: 800; }
    .note { color: var(--muted); font-size: 13px; line-height: 1.5; }
    .rabi-field {
      position: relative;
      display: block;
      min-width: 0;
    }
    .rabi-field input,
    .rabi-field textarea,
    .combo-trigger {
      width: 100%;
      min-height: 48px;
      border: 1px solid rgba(17, 32, 51, .18);
      border-radius: 8px;
      padding: 17px 12px 7px;
      background: var(--field);
      color: var(--ink);
      outline: none;
      transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
    }
    .rabi-field textarea { min-height: 82px; resize: vertical; }
    .rabi-field input:focus,
    .rabi-field textarea:focus,
    .combo.open .combo-trigger,
    .combo-trigger:focus { border-color: rgba(25, 191, 193, .72); box-shadow: 0 0 0 3px rgba(25, 191, 193, .14); background: #fff; }
    .field-label {
      position: absolute;
      left: 11px;
      top: -7px;
      z-index: 1;
      max-width: calc(100% - 22px);
      padding: 0 5px;
      background: linear-gradient(180deg, rgba(255, 255, 255, .96), rgba(255, 255, 255, .96));
      color: var(--muted);
      font-size: 12px;
      font-weight: 750;
      line-height: 1.2;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .form { display: grid; gap: 12px; }
    .password-field input { padding-right: 50px; }
    .password-field button {
      position: absolute;
      right: 4px;
      top: 4px;
      display: inline-grid;
      place-items: center;
      width: 40px;
      height: 40px;
      padding: 0;
      background: transparent;
      color: var(--muted);
    }
    .password-field button:hover { background: var(--field-hover); color: var(--title); }
    .password-field svg { width: 20px; height: 20px; stroke: currentColor; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    button {
      border: 0;
      border-radius: 8px;
      padding: 10px 13px;
      background: var(--soft);
      color: #0f8b8d;
      cursor: pointer;
      font-weight: 720;
    }
    button.primary { background: var(--brand); color: var(--brand-ink); box-shadow: 0 8px 18px rgba(17, 32, 51, .16); }
    button.danger { background: #fff0ee; color: var(--danger); }
    button:disabled { opacity: .55; cursor: wait; }
    .status { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .pill { display: inline-flex; align-items: center; min-height: 30px; border-radius: 999px; padding: 5px 10px; background: var(--soft); color: #0f8b8d; font-size: 13px; font-weight: 800; }
    .pill.warn { background: #fff6df; color: var(--warn); }
    .alert { border-radius: 8px; padding: 11px 12px; margin-bottom: 14px; background: #fff0ee; color: var(--danger); border: 1px solid #ffd1ca; }
    .notice { border-radius: 8px; padding: 11px 12px; margin-bottom: 14px; background: var(--soft); color: #0f8b8d; border: 1px solid rgba(25, 191, 193, .28); }
    .app-list { display: grid; gap: 12px; }
    .app { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: rgba(255, 255, 255, .74); }
    .app-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .app-name { color: var(--title); font-weight: 850; }
    .app-id { color: var(--muted); font-size: 13px; word-break: break-all; }
    .meta { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 12px 0; }
    .tile { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: rgba(255, 255, 255, .82); min-width: 0; }
    .tile > span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; font-weight: 750; }
    .tile b { display: block; min-height: 20px; overflow-wrap: anywhere; font-size: 13px; }
    .switch-field { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; color: var(--title); font-weight: 800; user-select: none; }
    .switch-field input { position: absolute; opacity: 0; pointer-events: none; }
    .switch-track { position: relative; width: 54px; height: 28px; border-radius: 999px; background: rgba(17, 32, 51, .42); box-shadow: inset 0 1px 2px rgba(17, 32, 51, .14); transition: background .16s ease; }
    .switch-thumb { position: absolute; left: -2px; top: -2px; width: 32px; height: 32px; border-radius: 50%; background: #fffaf0; box-shadow: 0 8px 18px rgba(17, 32, 51, .2); transition: transform .16s ease; }
    .switch-field input:checked + .switch-track { background: var(--accent); }
    .switch-field input:checked + .switch-track .switch-thumb { transform: translateX(26px); }
    .switch-field input:focus-visible + .switch-track { box-shadow: 0 0 0 3px rgba(25, 191, 193, .18), inset 0 1px 2px rgba(17, 32, 51, .14); }
    .combo { position: relative; min-width: 0; }
    .combo-trigger { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; min-height: 48px; text-align: left; color: var(--ink); cursor: pointer; }
    .combo-trigger::after { content: ""; width: 7px; height: 7px; border-right: 2px solid #667586; border-bottom: 2px solid #667586; transform: rotate(45deg); margin-top: -4px; }
    .combo-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 750; }
    .combo-panel { position: absolute; z-index: 20; left: 0; right: 0; top: calc(100% + 4px); display: grid; gap: 8px; border: 1px solid rgba(17, 32, 51, .14); border-radius: 8px; padding: 8px; background: #fff; box-shadow: 0 18px 34px rgba(15, 23, 42, .14); }
    .combo-search { min-height: 38px !important; padding: 8px 10px !important; border-radius: 8px !important; font-size: 13px; }
    .combo-options { display: grid; gap: 4px; max-height: 220px; overflow: auto; }
    .combo-option { display: grid; gap: 2px; width: 100%; border: 1px solid transparent; border-radius: 8px; padding: 8px 9px; background: transparent; color: var(--ink); text-align: left; cursor: pointer; }
    .combo-option:hover, .combo-option.active { border-color: rgba(25, 191, 193, .42); background: rgba(236, 252, 255, .82); }
    .combo-option strong { min-width: 0; color: var(--title); font-size: 13px; font-weight: 850; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .combo-option span { min-width: 0; color: var(--muted); font-size: 12px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .worker-list { display: grid; gap: 10px; }
    .worker { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: start; border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: rgba(255, 255, 255, .74); }
    .worker-name { color: var(--title); font-weight: 850; overflow-wrap: anywhere; }
    .worker-meta { margin-top: 3px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
    .worker-actions { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .webgui { display: inline-flex; align-items: center; min-height: 26px; border-radius: 6px; padding: 4px 9px; background: rgba(25, 191, 193, .12); color: #0f8b8d; font-size: 12px; font-weight: 760; text-decoration: none; }
    .webgui:hover { background: #d1fae5; }
    .webgui.disabled { color: var(--muted); background: #eef1f0; pointer-events: none; }
    .dot { display: inline-flex; align-items: center; min-height: 26px; border-radius: 999px; padding: 4px 9px; background: var(--soft); color: #0f8b8d; font-size: 12px; font-weight: 760; }
    .dot.idle { background: #eef1f0; color: var(--muted); }
    .empty { padding: 28px; text-align: center; color: var(--muted); border: 1px dashed rgba(17, 32, 51, .18); border-radius: 8px; background: rgba(255, 255, 255, .7); }
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
          <h1>RabiLink服务器控制台</h1>
          <div class="subtitle">管理控制台：账号、应用 token、PC Rabi 连接和远程 WebGUI</div>
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
      <span id="workerCountPill" class="pill">0 台 PC Rabi</span>
    </div>

    <section class="grid">
      <div>
        <div id="loginCard" class="card">
          <div class="title-row">
            <div>
              <div id="authTitle" class="title">登录</div>
              <div id="authNote" class="note">使用服务器账号进入 RabiLink服务器控制台。</div>
            </div>
          </div>
          <div class="form">
            <label class="rabi-field"><span class="field-label">账号</span><input id="username" autocomplete="username" /></label>
            <label class="rabi-field password-field">
              <span class="field-label">密码</span>
              <input id="password" type="password" autocomplete="current-password" />
              <button id="togglePasswordButton" type="button" aria-label="显示密码" title="显示密码"></button>
            </label>
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
            <label class="rabi-field"><span class="field-label">应用名称</span><input id="appName" value="Rokid Glass" /></label>
            <label class="rabi-field"><span class="field-label">备注</span><textarea id="appNotes" placeholder="例如：生产眼镜、测试手机、家里局域网"></textarea></label>
          </div>
          <div class="actions">
            <button id="createAppButton" class="primary">创建应用</button>
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <div class="title-row">
            <div>
              <div class="title">已连接的 PC Rabi</div>
              <div class="note">当前账号下所有应用 token 连上的 PC Rabi 都会显示在这里，可直接跳转到对应 WebGUI。</div>
            </div>
          </div>
          <div id="workers" class="worker-list"></div>
          <div id="workersEmpty" class="empty">还没有 PC Rabi 上线。启动已绑定服务器 token 的 RabiRoute 后会自动出现。</div>
        </div>

        <div class="card">
          <div class="title-row">
            <div>
              <div class="title">应用列表</div>
              <div class="note">卡片默认显示 token 预览，登录后可以随时复制完整 token；每个应用可以指定要通讯的 Rabi PC。</div>
            </div>
          </div>
          <div id="apps" class="app-list"></div>
          <div id="empty" class="empty">还没有应用。先登录或完成首次注册，然后创建一个 RabiLink 应用。</div>
        </div>
      </div>
    </section>
  </main>

  <script>
    const apiBase = "/manage/api";
    const credentialStorageKey = "rabilinkManageCredentials";
    const legacyCredentialStorageKey = "rabilinkAdminCredentials";
    const state = { account: null, apps: [], workers: [], revealed: {}, credentials: loadCredentials(), setupRequired: false };
    const el = (id) => document.getElementById(id);

    function encodeAuth(username, password) {
      return btoa(unescape(encodeURIComponent(username + ":" + password)));
    }

    function passwordIcon(visible) {
      return visible
        ? '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 3l18 18" stroke-width="2" stroke-linecap="round"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" stroke-width="2" stroke-linecap="round"/><path d="M9.9 4.2A9.7 9.7 0 0 1 12 4c5 0 8.7 4 10 8a12.5 12.5 0 0 1-2.4 3.9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.1 6.4A12.3 12.3 0 0 0 2 12c1.3 4 5 8 10 8 1.4 0 2.8-.3 4-.9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke-width="2"/></svg>';
    }

    function setPasswordVisible(visible) {
      const passwordInput = el("password");
      const toggleButton = el("togglePasswordButton");
      passwordInput.type = visible ? "text" : "password";
      toggleButton.innerHTML = passwordIcon(visible);
      toggleButton.setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
      toggleButton.title = visible ? "隐藏密码" : "显示密码";
    }

    function consoleAccountFromPath() {
      const prefix = "/manage/";
      if (!window.location.pathname.startsWith(prefix)) return "";
      const segment = window.location.pathname.slice(prefix.length).split("/")[0] || "";
      try { return decodeURIComponent(segment); } catch { return segment; }
    }

    function consolePathFor(username) {
      return "/manage/" + encodeURIComponent(username);
    }

    function setConsolePath(username, replace = true) {
      if (!username) return;
      const target = consolePathFor(username);
      if (window.location.pathname === target) return;
      const method = replace ? "replaceState" : "pushState";
      window.history[method](null, "", target);
    }

    function loadCredentials() {
      try {
        const current = localStorage.getItem(credentialStorageKey);
        const legacy = localStorage.getItem(legacyCredentialStorageKey);
        const parsed = JSON.parse(current || legacy || "null");
        if (parsed && !current) {
          localStorage.setItem(credentialStorageKey, JSON.stringify(parsed));
          localStorage.removeItem(legacyCredentialStorageKey);
        }
        return parsed;
      } catch { return null; }
    }

    function saveCredentials(username, password) {
      state.credentials = { username, auth: encodeAuth(username, password) };
      localStorage.setItem(credentialStorageKey, JSON.stringify(state.credentials));
      localStorage.removeItem(legacyCredentialStorageKey);
    }

    function clearCredentials() {
      state.credentials = null;
      localStorage.removeItem(credentialStorageKey);
      localStorage.removeItem(legacyCredentialStorageKey);
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
        const body = await request(apiBase + "/state");
        state.account = body.account;
        state.apps = body.apps || [];
        state.workers = body.workers || [];
        state.setupRequired = Boolean(body.setupRequired);
        if (state.account?.username) {
          const pathAccount = consoleAccountFromPath();
          if (pathAccount && pathAccount !== state.account.username) {
            flash("notice", "当前浏览器已登录 " + state.account.username + "，已切回该账号控制台。");
          }
          setConsolePath(state.account.username);
        }
      } catch (error) {
        state.account = null;
        state.apps = [];
        state.workers = [];
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
        await request(apiBase + "/login", {
          method: "POST",
          body: JSON.stringify({ username, password })
        });
        saveCredentials(username, password);
        el("password").value = "";
        flash("notice", "已登录。");
        setConsolePath(username, false);
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
        await request(apiBase + "/accounts", {
          method: "POST",
          body: JSON.stringify({ username, password })
        });
        saveCredentials(username, password);
        el("password").value = "";
        flash("notice", "账号已创建。");
        setConsolePath(username, false);
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
        const body = await request(apiBase + "/apps", {
          method: "POST",
          body: JSON.stringify({ name: el("appName").value, notes: el("appNotes").value })
        });
        if (body.app?.token) state.revealed[body.app.id] = body.app.token;
        el("appNotes").value = "";
        flash("notice", "应用已创建，可随时复制完整 token。");
        await load();
      } catch (error) {
        flash("alert", error.message);
      } finally {
        setBusy(el("createAppButton"), false);
      }
    }

    async function patchApp(id, patch) {
      const body = await request(apiBase + "/apps/" + encodeURIComponent(id), {
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
      await request(apiBase + "/apps/" + encodeURIComponent(id), { method: "DELETE" });
      delete state.revealed[id];
      flash("notice", "应用已删除。");
      await load();
    }

    async function copyToken(id) {
      const app = state.apps.find((item) => item.id === id);
      const token = app?.token || state.revealed[id];
      if (!token) {
        flash("notice", "未拿到完整 token，请刷新后重试。");
        return;
      }
      await navigator.clipboard.writeText(token);
      flash("notice", "token 已复制。");
    }

    function workerLabel(worker) {
      if (!worker) return "未指定";
      return worker.name && worker.name !== worker.id ? worker.name + " (" + worker.id + ")" : worker.id;
    }

    function workerGuid(worker) {
      return worker?.guid || worker?.id || "";
    }

    function workerWebguiUrl(worker) {
      if (!state.account || !workerGuid(worker)) return "";
      return "/manage/" + encodeURIComponent(state.account.username) + "/" + encodeURIComponent(workerGuid(worker)) + "/#/routes";
    }

    function workersForApp(appId) {
      return state.workers.filter((worker) => worker.appId === appId);
    }

    function targetOptionsForApp(app) {
      const appWorkers = workersForApp(app.id);
      const options = [{
        value: "",
        title: appWorkers.length > 0 ? "自动选择可用 Rabi PC" : "自动选择（暂无已绑定 PC）",
        subtitle: appWorkers.length > 0 ? "由服务器把任务交给当前可用的绑定 PC" : "绑定 PC 上线后会自动出现在这里"
      }];
      for (const worker of appWorkers) {
        options.push({
          value: worker.id,
          title: workerLabel(worker),
          subtitle: (worker.guid ? "GUID " + worker.guid + " · " : "") + (worker.online ? "在线" : "最近离线")
        });
      }
      if (app.targetDeviceId && !appWorkers.some((worker) => worker.id === app.targetDeviceId)) {
        options.push({
          value: app.targetDeviceId,
          title: app.targetDeviceId,
          subtitle: "未上线"
        });
      }
      return options;
    }

    function closeCombos(except) {
      document.querySelectorAll(".combo.open").forEach((node) => {
        if (node !== except) node.classList.remove("open");
      });
      document.querySelectorAll(".combo-panel").forEach((node) => {
        if (!except || !except.contains(node)) node.classList.add("hidden");
      });
    }

    function renderTargetCombo(combo, app) {
      const trigger = combo.querySelector(".combo-trigger");
      const valueNode = combo.querySelector(".combo-value");
      const panel = combo.querySelector(".combo-panel");
      const search = combo.querySelector(".combo-search");
      const optionsNode = combo.querySelector(".combo-options");
      const options = targetOptionsForApp(app);
      const selected = options.find((option) => option.value === (app.targetDeviceId || "")) || options[0];
      valueNode.textContent = selected?.title || "自动选择";

      function paintOptions(filterText = "") {
        const normalized = filterText.trim().toLowerCase();
        const visibleOptions = options.filter((option) => !normalized
          || option.title.toLowerCase().includes(normalized)
          || option.subtitle.toLowerCase().includes(normalized)
          || option.value.toLowerCase().includes(normalized));
        optionsNode.innerHTML = "";
        for (const option of visibleOptions) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "combo-option";
          button.classList.toggle("active", option.value === (app.targetDeviceId || ""));
          button.innerHTML = "<strong></strong><span></span>";
          button.querySelector("strong").textContent = option.title;
          button.querySelector("span").textContent = option.subtitle;
          button.addEventListener("click", () => {
            closeCombos();
            if (option.value !== (app.targetDeviceId || "")) {
              patchApp(app.id, { targetDeviceId: option.value }).catch((error) => flash("alert", error.message));
            }
          });
          optionsNode.appendChild(button);
        }
        if (visibleOptions.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.style.padding = "12px";
          empty.textContent = "没有匹配的 Rabi PC";
          optionsNode.appendChild(empty);
        }
      }

      paintOptions();
      trigger.addEventListener("click", () => {
        const isOpen = combo.classList.contains("open");
        closeCombos(combo);
        combo.classList.toggle("open", !isOpen);
        panel.classList.toggle("hidden", isOpen);
        if (!isOpen) {
          search.value = "";
          paintOptions();
          window.setTimeout(() => search.focus(), 0);
        }
      });
      search.addEventListener("input", () => paintOptions(search.value));
    }

    function renderWorkers() {
      const container = el("workers");
      container.innerHTML = "";
      el("workersEmpty").classList.toggle("hidden", state.workers.length > 0);
      for (const worker of state.workers) {
        const node = document.createElement("div");
        node.className = "worker";
        node.innerHTML =
          '<div>' +
            '<div class="worker-name"></div>' +
            '<div class="worker-meta"></div>' +
          '</div>' +
          '<div class="worker-actions"><a class="webgui" target="_blank" rel="noopener">打开 PC WebGUI</a><span class="dot"></span></div>';
        node.querySelector(".worker-name").textContent = workerLabel(worker);
        const appLabel = worker.appName || worker.appId || "-";
        const tokenLabel = worker.appTokenPreview ? "（" + worker.appTokenPreview + "）" : "";
        node.querySelector(".worker-meta").textContent =
          "应用 token：" + appLabel + tokenLabel + " · GUID：" + (worker.guid || "-") + " · 最近连接：" + (worker.lastSeenAt || "-");
        const webgui = node.querySelector(".webgui");
        const webguiUrl = workerWebguiUrl(worker);
        if (webguiUrl) {
          webgui.href = webguiUrl;
        } else {
          webgui.removeAttribute("href");
          webgui.classList.add("disabled");
        }
        const dot = node.querySelector(".dot");
        dot.textContent = worker.online ? "在线" : "最近离线";
        dot.classList.toggle("idle", !worker.online);
        container.appendChild(node);
      }
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
      el("workerCountPill").textContent = state.workers.length + " 台 PC Rabi";
      el("authTitle").textContent = state.setupRequired ? "首次注册" : "登录";
      el("authNote").textContent = state.setupRequired ? "创建服务器上的第一个管理账号。" : "每个浏览器只保留一个当前登录账号，用于进入 RabiLink服务器控制台。";
      el("registerButton").textContent = state.setupRequired ? "创建第一个账号" : "新增账号";
      renderWorkers();

      const container = el("apps");
      container.innerHTML = "";
      el("empty").classList.toggle("hidden", state.apps.length > 0);
      for (const app of state.apps) {
        const token = app.tokenPreview || (state.revealed[app.id] ? "完整 token 已加载" : "");
        const node = document.createElement("div");
        node.className = "app";
        node.innerHTML =
          '<div class="app-head">' +
            '<div><div class="app-name"></div><div class="app-id"></div></div>' +
            '<label class="switch-field"><input class="enabled" type="checkbox"><span class="switch-track"><span class="switch-thumb"></span></span><b>启用</b></label>' +
          '</div>' +
          '<div class="meta">' +
            '<div class="tile"><span>Token</span><b class="token"></b></div>' +
            '<div class="tile"><span>备注</span><b class="notes"></b></div>' +
            '<div class="tile"><div class="rabi-field combo target-worker"><span class="field-label">通讯 Rabi PC</span><button class="combo-trigger" type="button"><span class="combo-value"></span></button><div class="combo-panel hidden"><input class="combo-search" placeholder="搜索 Rabi PC / GUID"><div class="combo-options"></div></div></div></div>' +
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
        renderTargetCombo(node.querySelector(".target-worker"), app);
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
    el("togglePasswordButton").addEventListener("click", () => {
      const passwordInput = el("password");
      setPasswordVisible(passwordInput.type !== "text");
      passwordInput.focus();
    });
    el("createAppButton").addEventListener("click", createApp);
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".combo")) closeCombos();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeCombos();
    });
    el("logoutButton").addEventListener("click", () => {
      request(apiBase + "/logout", { method: "POST" }).catch(() => {});
      clearCredentials();
      state.account = null;
      state.apps = [];
      state.workers = [];
      window.history.replaceState(null, "", "/manage");
      flash("notice", "已退出。");
      render();
    });
    setPasswordVisible(false);
    load();
  </script>
</body>
</html>`;
}

function manageApiPath(url) {
  if (url.pathname.startsWith("/manage/api/")) return url.pathname.slice("/manage/api".length) || "/";
  if (url.pathname.startsWith("/admin/api/")) return url.pathname.slice("/admin/api".length) || "/";
  return "";
}

function manageWebguiMatch(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "manage" || parts[1] === "api" || parts.length < 3) return null;
  let restParts = parts.slice(3);
  const legacyWebgui = restParts[0] === "webgui";
  if (restParts[0] === "webgui") {
    restParts = restParts.slice(1);
  }
  return {
    username: decodeURIComponent(parts[1]),
    targetRef: decodeURIComponent(parts[2]),
    legacyWebgui,
    restPath: restParts.length > 0 ? `/${restParts.map((part) => decodeURIComponent(part)).join("/")}` : "/"
  };
}

function resolveOwnedWebguiTarget(account, targetRef, url) {
  const store = readAppStore();
  const ownedApps = store.apps.filter((app) => app.ownerAccountId === account.id && app.enabled !== false);
  const appsById = new Map(ownedApps.map((app) => [app.id, app]));
  const ownedWorkers = store.workers.filter((worker) => appsById.has(worker.appId));
  const requestedAppId = stringValue(url.searchParams.get("appId"));
  const requestedApp = requestedAppId ? appsById.get(requestedAppId) : null;
  let worker = ownedWorkers.find((item) => item.guid === targetRef)
    || ownedWorkers.find((item) => item.id === targetRef);
  if (worker && requestedApp && worker.appId !== requestedApp.id) {
    worker = null;
  }
  if (worker) {
    return { app: appsById.get(worker.appId), worker };
  }
  const app = appsById.get(targetRef);
  if (app) {
    const appWorkers = ownedWorkers.filter((item) => item.appId === app.id);
    const selected = app.targetDeviceId
      ? appWorkers.find((item) => item.id === app.targetDeviceId || item.guid === app.targetDeviceId)
      : null;
    worker = selected || appWorkers[0] || null;
    if (worker) return { app, worker };
  }
  const error = new Error(`Rabi PC not found or offline for this account: ${targetRef}`);
  error.statusCode = 404;
  throw error;
}

function contentTypeForFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".ico") return "image/x-icon";
  if (extension === ".svg") return "image/svg+xml; charset=utf-8";
  if (extension === ".ttf") return "font/ttf";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  if (extension === ".eot") return "application/vnd.ms-fontobject";
  return "application/octet-stream";
}

function safeChildPath(rootPath, requestPath) {
  const normalized = path.normalize(decodeURIComponent(requestPath)).replace(/^[/\\]+/, "");
  const candidate = path.resolve(rootPath, normalized);
  const relative = path.relative(rootPath, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return candidate;
}

function remoteWebguiPrefix(account, targetRef) {
  return `/manage/${encodeURIComponent(account.username)}/${encodeURIComponent(targetRef)}`;
}

function remoteWebguiManagerPath(restPath) {
  return restPath === "/manager-config"
    || restPath === "/meta"
    || restPath === "/network-options"
    || restPath === "/open-config-file"
    || restPath === "/manager"
    || restPath.startsWith("/manager/")
    || restPath === "/gateways"
    || restPath.startsWith("/gateways/")
    || restPath === "/api"
    || restPath.startsWith("/api/");
}

function rewriteRemoteWebguiAssetUrls(text, externalPrefix) {
  return text
    .replaceAll('"/assets/', `"${externalPrefix}/assets/`)
    .replaceAll("'/assets/", `'${externalPrefix}/assets/`)
    .replaceAll("`/assets/", "`" + externalPrefix + "/assets/")
    .replaceAll("url(/assets/", `url(${externalPrefix}/assets/`)
    .replaceAll('url("/assets/', `url("${externalPrefix}/assets/`)
    .replaceAll("url('/assets/", `url('${externalPrefix}/assets/`);
}

function remoteWebguiIndexHtml(externalPrefix) {
  const indexPath = path.join(webguiDistPath, "index.html");
  if (!fs.existsSync(indexPath)) return "";
  const bootstrap = `<base href="${externalPrefix}/"><script>window.__RABI_MANAGER_API_BASE__=${JSON.stringify(externalPrefix)};</script>`;
  let text = fs.readFileSync(indexPath, "utf8");
  text = text.replace(/<base\s+[^>]*>/gi, "");
  text = text.replace(/<head([^>]*)>/i, `<head$1>${bootstrap}`);
  return rewriteRemoteWebguiAssetUrls(text, externalPrefix);
}

function sendRemoteWebguiStatic(res, match, account) {
  const externalPrefix = remoteWebguiPrefix(account, match.targetRef);
  if (match.restPath === "/" || !path.extname(match.restPath)) {
    const index = remoteWebguiIndexHtml(externalPrefix);
    if (!index) return sendText(res, 503, "RabiRoute WebGUI build is missing on the RabiLink server.");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(index);
    return true;
  }

  if (match.restPath.startsWith("/assets/")) {
    const assetRelativePath = match.restPath.slice("/assets/".length);
    const candidatePaths = [
      safeChildPath(path.join(webguiDistPath, "assets"), assetRelativePath),
      safeChildPath(webguiAssetPath, assetRelativePath)
    ].filter(Boolean);
    const filePath = candidatePaths.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!filePath) return sendText(res, 404, "Remote WebGUI asset was not found.");
    const contentType = contentTypeForFile(filePath);
    let body = fs.readFileSync(filePath);
    if (/text\/javascript|text\/css|application\/json/.test(contentType)) {
      body = Buffer.from(rewriteRemoteWebguiAssetUrls(body.toString("utf8"), externalPrefix), "utf8");
    }
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": contentType.startsWith("font/") || contentType.startsWith("image/") ? "public, max-age=3600" : "no-store",
      "content-length": String(body.byteLength)
    });
    res.end(body);
    return true;
  }

  return sendText(res, 404, "Remote WebGUI static file was not found.");
}

function rewriteWebguiText(text, externalPrefix, contentType) {
  let next = text
    .replaceAll("\"/api/", `"${externalPrefix}/api/`)
    .replaceAll("'/api/", `'${externalPrefix}/api/`)
    .replaceAll("`/api/", "`" + externalPrefix + "/api/")
    .replaceAll("\"/manager-config", `"${externalPrefix}/manager-config`)
    .replaceAll("'/manager-config", `'${externalPrefix}/manager-config`)
    .replaceAll("`/manager-config", "`" + externalPrefix + "/manager-config")
    .replaceAll("\"/assets/", `"${externalPrefix}/assets/`)
    .replaceAll("'/assets/", `'${externalPrefix}/assets/`)
    .replaceAll("`/assets/", "`" + externalPrefix + "/assets/");
  if (contentType.includes("text/html") && !/<base\s/i.test(next)) {
    next = next.replace(/<head([^>]*)>/i, `<head$1><base href="${externalPrefix}/">`);
  }
  return next;
}

function sendWebguiProxyResponse(res, request, externalPrefix) {
  if (request.status !== "done" || !request.response) {
    return sendText(res, request.status === "failed" ? 502 : 504, request.error || "Rabi PC WebGUI request timed out.");
  }
  const headers = normalizeProxyResponseHeaders(request.response.headers);
  const contentType = headers["content-type"] || "application/octet-stream";
  let body = Buffer.from(request.response.bodyBase64 || "", "base64");
  if (/text\/html|javascript|text\/css|application\/json/.test(contentType)) {
    body = Buffer.from(rewriteWebguiText(body.toString("utf8"), externalPrefix, contentType), "utf8");
  }
  res.writeHead(request.response.statusCode || 200, {
    ...headers,
    "content-type": contentType,
    "content-length": String(body.byteLength),
    "cache-control": "no-store"
  });
  res.end(body);
}

function mobileWorkersForApp(app) {
  const store = readAppStore();
  return store.workers
    .filter((worker) => worker.appId === app.id)
    .map((worker) => publicWorker(worker, app));
}

function selectedMobileWorker(app, workers = mobileWorkersForApp(app)) {
  if (app.targetDeviceId) {
    const selected = workers.find((worker) => worker.id === app.targetDeviceId || worker.guid === app.targetDeviceId);
    if (selected) return selected;
  }
  return workers.find((worker) => worker.online) || workers[0] || null;
}

function mobileStatePayload(app) {
  const workers = mobileWorkersForApp(app);
  return {
    code: 0,
    ok: true,
    app: publicApp(app),
    selectedTargetDeviceId: app.targetDeviceId || "",
    selectedWorker: selectedMobileWorker(app, workers),
    workers
  };
}

function patchMobileAppTarget(app, targetDeviceId) {
  const store = readAppStore();
  const storedApp = store.apps.find((item) => item.id === app.id);
  if (!storedApp) {
    const error = new Error(`RabiLink app not found: ${app.id}`);
    error.statusCode = 404;
    throw error;
  }
  const normalized = stringValue(targetDeviceId);
  if (normalized) {
    const worker = store.workers.find((item) => item.appId === app.id && (item.id === normalized || item.guid === normalized));
    if (!worker) {
      const error = new Error(`Rabi PC not found for this app token: ${normalized}`);
      error.statusCode = 404;
      throw error;
    }
    storedApp.targetDeviceId = worker.id;
  } else {
    storedApp.targetDeviceId = "";
  }
  storedApp.updatedAt = nowIso();
  writeAppStore(store);
  return storedApp;
}

function mobileWorkerTarget(app, url, body = {}) {
  const requested = stringValue(url.searchParams.get("targetDeviceId") || url.searchParams.get("rabiGuid") || body?.targetDeviceId || body?.rabiGuid);
  const workers = mobileWorkersForApp(app);
  const worker = requested
    ? workers.find((item) => item.id === requested || item.guid === requested)
    : selectedMobileWorker(app, workers);
  if (!worker) {
    const error = new Error("No Rabi PC is connected for this app token.");
    error.statusCode = 404;
    throw error;
  }
  if (!worker.online) {
    const error = new Error(`Rabi PC is offline or stale: ${worker.name || worker.id}`);
    error.statusCode = 503;
    throw error;
  }
  return worker;
}

async function mobileProxyJson(app, worker, method, localPath, body = null) {
  const request = createMobileWebguiRequest(app, worker, method, localPath, body);
  const finalRequest = await waitForWebguiRequest(request, webguiRequestWaitMs);
  if (finalRequest.status !== "done" || !finalRequest.response) {
    const error = new Error(finalRequest.error || "Rabi PC WebGUI request timed out.");
    error.statusCode = finalRequest.status === "failed" ? 502 : 504;
    throw error;
  }
  const responseBody = Buffer.from(finalRequest.response.bodyBase64 || "", "base64").toString("utf8");
  let parsed = {};
  try {
    parsed = responseBody.trim() ? JSON.parse(responseBody) : {};
  } catch {
    parsed = { code: -1, message: responseBody };
  }
  return { statusCode: finalRequest.response.statusCode || 200, body: parsed };
}

async function handleMobileApi(req, url, res, body) {
  const auth = authorizeRabiLinkRequest(req, url, body);
  if (!auth.ok) return sendRabiLinkAuthError(res, auth);
  if (!auth.app) return sendRabiLinkError(res, 401, "请使用 RabiLink服务器控制台里对应应用的 token。");
  const app = auth.app;
  if (req.method === "GET" && url.pathname === "/api/rabilink/mobile/state") {
    return sendJson(res, 200, mobileStatePayload(app));
  }
  if ((req.method === "PATCH" || req.method === "POST") && url.pathname === "/api/rabilink/mobile/target") {
    const updated = patchMobileAppTarget(app, body?.targetDeviceId || body?.rabiGuid || "");
    return sendJson(res, 200, mobileStatePayload(updated));
  }

  const routeMatch = url.pathname.match(/^\/api\/rabilink\/mobile\/routes(?:\/([^/]+)(?:\/(agent-options|agent-binding))?)?$/);
  if (!routeMatch) return sendJson(res, 404, { code: -1, ok: false, message: "Not found" });

  const worker = mobileWorkerTarget(app, url, body);
  const rabiGuid = worker.guid || worker.id;
  const routeId = routeMatch[1] ? decodeURIComponent(routeMatch[1]) : "";
  const action = routeMatch[2] || "";
  if (req.method === "GET" && !routeId && !action) {
    const result = await mobileProxyJson(app, worker, "GET", `/api/rabi/instances/${encodeURIComponent(rabiGuid)}/routes`);
    return sendJson(res, result.statusCode, result.body);
  }
  if (req.method === "GET" && routeId && action === "agent-options") {
    const result = await mobileProxyJson(app, worker, "GET", `/api/rabi/instances/${encodeURIComponent(rabiGuid)}/routes/${encodeURIComponent(routeId)}/agent-options`);
    return sendJson(res, result.statusCode, result.body);
  }
  if ((req.method === "PATCH" || req.method === "POST") && routeId && action === "agent-binding") {
    const result = await mobileProxyJson(app, worker, "PATCH", `/api/rabi/instances/${encodeURIComponent(rabiGuid)}/routes/${encodeURIComponent(routeId)}/agent-binding`, body || {});
    return sendJson(res, result.statusCode, result.body);
  }
  return sendJson(res, 405, { code: -1, ok: false, message: "Method not allowed" });
}

async function handleManageWebgui(req, url, res) {
  const match = manageWebguiMatch(url);
  if (!match) return false;
  const auth = authorizeAdmin(req, url);
  if (!auth.ok) {
    if (req.method === "GET") return redirect(res, "/manage");
    return sendText(res, 401, "Unauthorized");
  }
  if (auth.account.username !== match.username) {
    const target = `/manage/${encodeURIComponent(auth.account.username)}`;
    if (req.method === "GET") return redirect(res, target);
    return sendText(res, 403, "Forbidden");
  }
  const target = resolveOwnedWebguiTarget(auth.account, match.targetRef, url);
  const externalPrefix = remoteWebguiPrefix(auth.account, match.targetRef);
  if (match.legacyWebgui && req.method === "GET") {
    const targetUrl = `${externalPrefix}${match.restPath === "/" ? "/" : match.restPath}${url.search}`;
    return redirect(res, targetUrl, 308);
  }
  if (!remoteWebguiManagerPath(match.restPath)) {
    if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "Method Not Allowed");
    return sendRemoteWebguiStatic(res, match, auth.account);
  }
  const proxySearch = new URLSearchParams(url.searchParams);
  proxySearch.delete("appId");
  const localPath = `${match.restPath}${proxySearch.toString() ? `?${proxySearch}` : ""}`;
  const rawBody = req.method === "GET" || req.method === "HEAD" ? Buffer.alloc(0) : await readRawBody(req);
  const proxyRequest = createWebguiRequest(req, target, localPath, rawBody);
  const finalRequest = await waitForWebguiRequest(proxyRequest, webguiRequestWaitMs);
  sendWebguiProxyResponse(res, finalRequest, externalPrefix);
  return true;
}

async function handleAdminApi(req, url, res) {
  const body = req.method === "GET" ? {} : await readBody(req);
  const apiPath = manageApiPath(url);
  if (req.method === "GET" && apiPath === "/state") {
    const auth = authorizeAdmin(req, url, body);
    if (!auth.ok && !auth.setupRequired) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
    const headers = auth.account ? { "set-cookie": manageSessionCookie(createManageSession(auth.account)) } : {};
    return sendJson(res, 200, accountStorePayload(auth.account), headers);
  }
  if (req.method === "POST" && apiPath === "/login") {
    const account = loginAccount(body);
    const session = createManageSession(account);
    return sendJson(res, 200, { code: 0, ok: true, account: publicAccount(account) }, { "set-cookie": manageSessionCookie(session) });
  }
  if (req.method === "POST" && apiPath === "/accounts") {
    const account = createAccount(body);
    const session = createManageSession(account);
    return sendJson(res, 200, { code: 0, ok: true, account: publicAccount(account) }, { "set-cookie": manageSessionCookie(session) });
  }
  if (req.method === "POST" && apiPath === "/logout") {
    return sendJson(res, 200, { code: 0, ok: true }, { "set-cookie": clearManageSessionCookie() });
  }
  const auth = authorizeAdmin(req, url, body);
  if (!auth.ok) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  if (req.method === "POST" && apiPath === "/apps") {
    const app = createAppForAccount(auth.account, body);
    return sendJson(res, 200, { code: 0, ok: true, app: publicApp(app, { revealToken: true }) });
  }
  const appMatch = apiPath.match(/^\/apps\/([^/]+)$/);
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
      return redirect(res, "/manage");
    }
    if (url.pathname.startsWith("/manage/") && manageWebguiMatch(url)) {
      return await handleManageWebgui(req, url, res);
    }
    if (req.method === "GET" && (url.pathname === "/manage" || url.pathname === "/manage/" || /^\/manage\/[^/]+\/?$/.test(url.pathname))) {
      return sendHtml(res, adminPageHtml());
    }
    if (url.pathname.startsWith("/admin/api/") || url.pathname.startsWith("/manage/api/")) {
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
          url: "/manage",
          accounts: store.accounts.length,
          apps: store.apps.length,
          enabledApps: store.apps.filter((app) => app.enabled !== false).length,
          publicTokenConfigured: Boolean(legacyToken),
          publicTokenAccepted: false
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
    if (req.method === "GET" && (url.pathname === "/rokid/rabilink/openapi.agent-token.json" || url.pathname === "/openapi/rokid-rabilink-plugin.agent-token.json")) {
      return sendOpenApi(res, agentTokenOpenApiFileCandidates);
    }
    if (req.method === "GET" && (url.pathname === "/rokid/rabilink/tools.postman.json" || url.pathname === "/openapi/rokid-rabilink-tools.postman.json")) {
      return sendOpenApi(res, toolImportPostmanFileCandidates);
    }
    const body = req.method === "GET" ? {} : await readBody(req);
    if (url.pathname === "/api/rabilink/mobile/state"
      || url.pathname === "/api/rabilink/mobile/target"
      || url.pathname.startsWith("/api/rabilink/mobile/routes")) {
      return await handleMobileApi(req, url, res, body);
    }
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
    if (req.method === "GET" && url.pathname === "/worker/webgui-requests") {
      return await handleWorkerWebguiRequests(req, url, res, body);
    }
    if (req.method === "POST" && /^\/worker\/webgui-requests\/[^/]+\/response$/.test(url.pathname)) {
      return handleWorkerWebguiResponse(req, url, res, body);
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
    if (url.pathname === "/rokid/rabilink"
      || url.pathname === "/api/rokid/rabilink"
      || url.pathname.startsWith("/rokid/rabilink/")
      || url.pathname.startsWith("/api/rokid/rabilink/")) {
      return sendRabiLinkError(res, statusCode, message);
    }
    return sendJson(res, statusCode, { code: -1, ok: false, message });
  }
});

server.listen(port, host, () => {
  console.log(`RabiLink Relay listening on http://${host}:${port}`);
  console.log(`Data dir: ${dataDir}`);
});
