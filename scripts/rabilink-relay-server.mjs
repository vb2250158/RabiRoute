#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const port = Number(process.env.PORT || process.env.RABILINK_RELAY_PORT || 8788);
const host = process.env.HOST || process.env.RABILINK_RELAY_HOST || "0.0.0.0";
const token = process.env.RABILINK_RELAY_TOKEN || "";
const allowInsecure = process.env.RABILINK_RELAY_ALLOW_INSECURE === "1";
const replyTimeoutMs = clamp(Number(process.env.RABILINK_RELAY_REPLY_TIMEOUT_MS || 60000), 1000, 120000);
const messageWaitMs = clamp(Number(process.env.RABILINK_RELAY_MESSAGE_WAIT_MS || 60000), 0, 60000);
const outboxWaitMs = clamp(Number(process.env.RABILINK_RELAY_OUTBOX_WAIT_MS || 60000), 0, 60000);
const workerTaskWaitMs = clamp(Number(process.env.RABILINK_RELAY_WORKER_TASK_WAIT_MS || 60000), 0, 60000);
const taskTtlMs = clamp(Number(process.env.RABILINK_RELAY_TASK_TTL_MS || 10 * 60 * 1000), 60000, 24 * 60 * 60 * 1000);
const leaseMs = clamp(Number(process.env.RABILINK_RELAY_LEASE_MS || 45000), 5000, 10 * 60 * 1000);
const dataDir = path.resolve(process.env.RABILINK_RELAY_DATA_DIR || path.join(process.cwd(), "data", "rabilink-relay"));
const eventLogPath = path.join(dataDir, "events.jsonl");
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

if (!token && !allowInsecure) {
  console.error("RABILINK_RELAY_TOKEN is required for public deployment. Set RABILINK_RELAY_ALLOW_INSECURE=1 only for local testing.");
  process.exit(1);
}

fs.mkdirSync(dataDir, { recursive: true });

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

function sendJson(res, statusCode, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-rabilink-token"
  });
  res.end(text);
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

function assertAuthorized(req, url, body) {
  if (!token && allowInsecure) return true;
  return requestToken(req, url, body) === token;
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
    source: task.source,
    messageCount: task.messages.length,
    nextMessageSeq: task.nextMessageSeq,
    replyText: task.replyText || "",
    error: task.error || ""
  };
}

function createTask(raw, req) {
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
    source: {
      userAgent: String(req.headers["user-agent"] || ""),
      ip: String(req.socket.remoteAddress || ""),
      rokidRequestId: stringValue(raw?.requestId || raw?.id || raw?.messageId),
      sender: stringValue(raw?.sender || raw?.user || raw?.deviceId)
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

function claimTasks(limit, deviceId) {
  cleanupTasks();
  const now = Date.now();
  const result = [];
  for (const task of tasks.values()) {
    if (result.length >= limit) break;
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

function hasClaimableTasks() {
  cleanupTasks();
  const now = Date.now();
  for (const task of tasks.values()) {
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

function waitForClaimableTask(timeoutMs) {
  if (hasClaimableTasks() || timeoutMs <= 0) return Promise.resolve();
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
    taskId: message.taskId,
    taskMessageId: message.taskMessageId,
    createdAt: message.createdAt,
    text: message.text,
    final: message.final,
    status: message.status
  };
}

function hasOpenTasks() {
  cleanupTasks();
  for (const task of tasks.values()) {
    if (!isTerminalTask(task)) return true;
  }
  return false;
}

function hasOutboxMessagesAfter(after) {
  const afterText = stringValue(after);
  const afterSeq = Number(afterText.replace(/^out-/, ""));
  return outboxMessages.some((message) => {
    if (!afterText) return true;
    if (Number.isFinite(afterSeq) && afterSeq > 0) return message.seq > afterSeq;
    return message.id > afterText;
  });
}

function outboxMessagesAfter(after) {
  const afterText = stringValue(after);
  const afterSeq = Number(afterText.replace(/^out-/, ""));
  return outboxMessages.filter((message) => {
    if (!afterText) return true;
    if (Number.isFinite(afterSeq) && afterSeq > 0) return message.seq > afterSeq;
    return message.id > afterText;
  });
}

function outboxMessagesResponse(after) {
  cleanupTasks();
  const messages = outboxMessagesAfter(after);
  const last = messages[messages.length - 1] || outboxMessages[outboxMessages.length - 1];
  const openTasks = hasOpenTasks();
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

async function waitForOutboxMessagesAfter(after, timeoutMs) {
  if (hasOutboxMessagesAfter(after) || timeoutMs <= 0) return;
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
  if (!assertAuthorized(req, url, body)) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  const task = createTask(body, req);
  const wait = url.searchParams.get("wait");
  const shouldWait = wait == null || wait === "1" || wait.toLowerCase() === "true";
  const timeout = clamp(Number(url.searchParams.get("timeoutMs") || replyTimeoutMs), 1000, 120000);
  const finalTask = shouldWait ? await waitForTask(task, timeout) : task;
  sendJson(res, 200, rokidResponse(finalTask));
}

function handleRokidCreateTask(req, url, res, body) {
  if (!assertAuthorized(req, url, body)) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  const outboxCursor = currentOutboxCursor();
  const task = createTask(body, req);
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
  if (!assertAuthorized(req, url, body)) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
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
  cleanupTasks();
  sendJson(res, 200, rokidResponse(task));
}

async function handleRokidTaskMessages(req, url, res, body) {
  if (!assertAuthorized(req, url, body)) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
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
  cleanupTasks();
  const after = url.searchParams.get("after") || url.searchParams.get("cursor") || "";
  const waitMs = clamp(Number(url.searchParams.get("waitMs") || url.searchParams.get("timeoutMs") || messageWaitMs), 0, 60000);
  const finalTask = await waitForMessagesAfter(task, after, waitMs);
  sendJson(res, 200, taskMessagesResponse(finalTask, after));
}

async function handleRokidOutboxMessages(req, url, res, body) {
  if (!assertAuthorized(req, url, body)) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  cleanupTasks();
  const hasCursor = url.searchParams.has("after") || url.searchParams.has("cursor");
  const after = hasCursor
    ? url.searchParams.get("after") || url.searchParams.get("cursor") || ""
    : currentOutboxCursor();
  const waitMs = clamp(Number(url.searchParams.get("waitMs") || url.searchParams.get("timeoutMs") || outboxWaitMs), 0, 60000);
  await waitForOutboxMessagesAfter(after, waitMs);
  sendJson(res, 200, outboxMessagesResponse(after));
}

async function handleWorkerTasks(req, url, res, body) {
  if (!assertAuthorized(req, url, body)) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  const limit = clamp(Number(url.searchParams.get("limit") || 1), 1, 10);
  const deviceId = stringValue(url.searchParams.get("deviceId") || body?.deviceId);
  let claimed = claimTasks(limit, deviceId);
  if (claimed.length === 0) {
    const waitMs = clamp(Number(url.searchParams.get("waitMs") || url.searchParams.get("timeoutMs") || workerTaskWaitMs), 0, 60000);
    await waitForClaimableTask(waitMs);
    claimed = claimTasks(limit, deviceId);
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
  if (!assertAuthorized(req, url, body)) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  const match = url.pathname.match(/^\/worker\/tasks\/([^/]+)\/result$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
  const task = finishTask(taskId, body);
  sendJson(res, 200, { code: 0, ok: true, task: taskForResponse(task) });
}

function handleTaskMessagesAppend(req, url, res, body) {
  if (!assertAuthorized(req, url, body)) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  const match = url.pathname.match(/^\/worker\/tasks\/([^/]+)\/messages$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
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
  if (!assertAuthorized(req, url, body)) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  const match = url.pathname.match(/^\/worker\/tasks\/([^/]+)\/finish$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
  const task = findTaskOrThrow(taskId);
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
  if (!assertAuthorized(req, url, body)) return sendJson(res, 401, { code: -1, ok: false, message: "Unauthorized" });
  const match = url.pathname.match(/^\/worker\/tasks\/([^/]+)$/);
  const taskId = match ? decodeURIComponent(match[1]) : "";
  const task = tasks.get(taskId);
  if (!task) return sendJson(res, 404, { code: -1, ok: false, message: `Task not found: ${taskId}` });
  sendJson(res, 200, { code: 0, ok: true, task: taskForResponse(task) });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      cleanupTasks();
      return sendJson(res, 200, {
        code: 0,
        ok: true,
        name: "RabiLink Relay",
        time: nowIso(),
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
