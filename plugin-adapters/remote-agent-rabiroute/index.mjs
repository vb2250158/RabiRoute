import fs from "node:fs";
import http from "node:http";
import dgram from "node:dgram";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { parseAllowedCwdRoots, resolveRealDirectory, resolveRealFileWithinRoots, resolveTaskCwd as enforceTaskCwd } from "./cwd-policy.mjs";
import { KeyedTaskQueue } from "./keyed-task-queue.mjs";
import { normalizePublicControlUrl } from "./public-control-url.mjs";
import { RemoteTaskLifecycle } from "./task-lifecycle.mjs";
import { CodexThreadCoordinator } from "./thread-coordinator.mjs";

const PROTOCOL_VERSION = 3;
const bridgeVersion = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const controlHost = process.env.REMOTE_AGENT_CONTROL_HOST || "0.0.0.0";
const controlPortStart = Number(process.env.REMOTE_AGENT_CONTROL_PORT || "8797");
const discoveryPortStart = Number(process.env.REMOTE_AGENT_DISCOVERY_PORT_START || process.env.REMOTE_AGENT_DISCOVERY_PORT || "8798");
const discoveryPortEnd = Number(process.env.REMOTE_AGENT_DISCOVERY_PORT_END || "8818");
const configuredPassword = process.env.REMOTE_AGENT_PASSWORD?.trim() || "";
if (configuredPassword && Buffer.byteLength(configuredPassword, "utf8") < 16) {
  throw new Error("REMOTE_AGENT_PASSWORD must be at least 16 UTF-8 bytes.");
}
const password = configuredPassword || randomBytes(24).toString("base64url");
const deviceId = process.env.REMOTE_AGENT_DEVICE_ID || os.hostname();
const deviceName = process.env.REMOTE_AGENT_DEVICE_NAME || os.hostname();
const agentType = process.env.REMOTE_AGENT_TYPE || "codex";
const defaultCwd = resolveRealDirectory(process.env.REMOTE_AGENT_DEFAULT_CWD || process.cwd(), "REMOTE_AGENT_DEFAULT_CWD");
const defaultThreadName = process.env.REMOTE_AGENT_DEFAULT_THREAD || "Remote Agent";
const publicHost = process.env.REMOTE_AGENT_PUBLIC_HOST || "";
const publicControlUrl = normalizePublicControlUrl(process.env.REMOTE_AGENT_PUBLIC_CONTROL_URL);
const fileStoreDir = process.env.REMOTE_AGENT_FILE_DIR || path.join(os.tmpdir(), "rabiroute-remote-agent-files", deviceId);
const singleFileLimitBytes = Number(process.env.REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES || 10 * 1024 * 1024);
const totalFileLimitBytes = Number(process.env.REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES || 25 * 1024 * 1024);
const allowNetwork = process.env.REMOTE_AGENT_ALLOW_NETWORK === "1";
const allowedCwdRoots = parseAllowedCwdRoots(process.env.REMOTE_AGENT_ALLOWED_CWDS, defaultCwd);
const taskTerminalTimeoutMs = positiveDuration("REMOTE_AGENT_TASK_TIMEOUT_MS", 30 * 60 * 1000);
const resumedTurnWaitMs = positiveDuration("REMOTE_AGENT_RESUMED_TURN_WAIT_MS", 30 * 1000);

let actualControlPort = 0;
let discoveryPort = 0;
let discoveryWarning = "";
let managerSocket = null;
let managerInfo = null;
let codexClient = null;
let cachedDefaultModel = "";
let threadCoordinator = null;
const pendingTaskEvents = [];
const MAX_PENDING_TASK_EVENTS = 1000;
const threadTaskQueue = new KeyedTaskQueue();
const taskCwdById = new Map();

function positiveDuration(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number.`);
  return value;
}

function firstLocalIp() {
  const scored = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family !== "IPv4" || item.internal) continue;
      const label = name.toLowerCase();
      let score = 0;
      if (item.address.startsWith("192.168.") || item.address.startsWith("10.") || item.address.startsWith("172.")) score += 20;
      if (label.includes("wi-fi") || label.includes("wifi") || label.includes("ethernet") || label.includes("以太网") || label.includes("wlan")) score += 10;
      if (label.includes("zerotier") || label.includes("tailscale")) score += 8;
      if (label.includes("wsl") || label.includes("vethernet") || label.includes("tap") || label.includes("loopback")) score -= 30;
      if (item.address.startsWith("169.254.")) score -= 20;
      scored.push({ address: item.address, score });
    }
  }
  return scored.sort((left, right) => right.score - left.score)[0]?.address ?? "127.0.0.1";
}

function deviceInfo() {
  return {
    deviceId,
    deviceName,
    agentType,
    os: process.platform,
    osVersion: os.release(),
    arch: process.arch,
    declaredIp: firstLocalIp(),
    defaultCwd,
    defaultThreadName
  };
}

function localRemoteAddress(value) {
  const address = String(value || "").replace(/^::ffff:/, "");
  return address === "::1" || address === "localhost" || address === "127.0.0.1" || address.startsWith("127.");
}

function resolveTaskCwd(value) {
  return enforceTaskCwd(value, { defaultCwd, allowedCwdRoots });
}

function managerAuthProof(nonce) {
  return createHmac("sha256", password)
    .update(`rabiroute.remote-agent.v3:manager:${nonce}`)
    .digest("base64url");
}

function serverAuthProof(nonce) {
  return createHmac("sha256", password)
    .update(`rabiroute.remote-agent.v3:server:${nonce}`)
    .digest("base64url");
}

function managerAuthProofMatches(candidate, nonce) {
  const expected = Buffer.from(managerAuthProof(nonce), "utf8");
  const actual = Buffer.from(String(candidate || ""), "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).byteLength > 1024 * 1024) {
        reject(new Error("Payload too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolve(text ? JSON.parse(text) : {});
    });
    request.on("error", reject);
  });
}

function jsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function htmlResponse(response) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
  <html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>RabiRoute Remote Agent</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 24px; color: #172026; background: #f7f8fa; }
      main { max-width: 760px; margin: auto; background: white; border: 1px solid #dde3ea; border-radius: 8px; padding: 20px; }
      code { word-break: break-all; }
      .status { color: #496579; margin: 8px 0 16px; }
    </style>
  </head>
  <body>
    <main>
      <h1>RabiRoute Remote Agent</h1>
      <div class="status">设备：${deviceName} (${deviceId}) · agentType=${agentType} · ${process.platform}/${process.arch}</div>
      <p>远端 Agent 已无人值守启动。请回到 RabiGUI 扫描局域网远端 Agent，并输入密码连接。</p>
      <p>认证密码：<code>${configuredPassword ? "已通过 REMOTE_AGENT_PASSWORD 配置" : "本次启动已生成高熵临时密码，请查看本机终端"}</code></p>
      <p>控制端口：<code>${actualControlPort || "-"}</code></p>
      <p>发现端口：<code>${discoveryPort || discoveryWarning || "-"}</code></p>
    </main>
  </body>
  </html>`);
}

function queueTaskEvent(payload) {
  if (pendingTaskEvents.length >= MAX_PENDING_TASK_EVENTS) {
    const droppableIndex = pendingTaskEvents.findIndex((event) => event.status !== "completed" && event.status !== "failed");
    if (droppableIndex >= 0) {
      pendingTaskEvents.splice(droppableIndex, 1);
      console.error("Remote Agent pending task-event queue reached its limit; the oldest non-terminal event was dropped.");
    } else if (payload.status !== "completed" && payload.status !== "failed") {
      console.error("Remote Agent pending task-event queue contains only terminal events; a new non-terminal event was dropped.");
      return;
    }
  }
  pendingTaskEvents.push(payload);
}

function dispatchTaskEvent(event) {
  const payload = { type: "taskEvent", ...event, device: deviceInfo() };
  if (managerSocket?.readyState === WebSocket.OPEN) {
    try {
      managerSocket.send(JSON.stringify(payload));
      return;
    } catch (error) {
      console.error(`Remote Agent could not send a task event immediately; it was queued: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  queueTaskEvent(payload);
}

function flushPendingTaskEvents() {
  if (managerSocket?.readyState !== WebSocket.OPEN) return;
  while (pendingTaskEvents.length) {
    try {
      managerSocket.send(JSON.stringify(pendingTaskEvents[0]));
      pendingTaskEvents.shift();
    } catch (error) {
      console.error(`Remote Agent could not flush pending task events: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
}

const taskLifecycle = new RemoteTaskLifecycle({ emit: dispatchTaskEvent });

function sendTaskEvent(event) {
  return taskLifecycle.send(event);
}

function safeFileName(value, fallback) {
  const base = path.basename(String(value || "").trim()).replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_");
  return base || fallback;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function stableClientMessageId(taskId) {
  const hex = createHash("sha256").update(String(taskId || "remote-agent-task")).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function assertFileTransferSize(size, total, label) {
  if (singleFileLimitBytes > 0 && size > singleFileLimitBytes) {
    throw new Error(`Remote Agent file is too large (${size} bytes): ${label}. Limit: ${singleFileLimitBytes} bytes.`);
  }
  if (totalFileLimitBytes > 0 && total > totalFileLimitBytes) {
    throw new Error(`Remote Agent files exceed total limit (${total} bytes). Limit: ${totalFileLimitBytes} bytes.`);
  }
}

function taskFileDir(taskId) {
  return path.join(fileStoreDir, "inbox", safeFileName(taskId, "task"));
}

function materializeTaskFiles(task) {
  const files = Array.isArray(task.files) ? task.files : [];
  if (!files.length) return [];
  const dir = taskFileDir(task.taskId);
  fs.mkdirSync(dir, { recursive: true });
  let total = 0;
  return files.map((file, index) => {
    const buffer = Buffer.from(String(file.contentBase64 || ""), "base64");
    total += buffer.byteLength;
    assertFileTransferSize(buffer.byteLength, total, file.name || `file-${index + 1}`);
    const name = safeFileName(file.name || `file-${index + 1}`, `file-${index + 1}`);
    const outPath = path.join(dir, name);
    fs.writeFileSync(outPath, buffer);
    const digest = sha256(buffer);
    if (file.sha256 && file.sha256 !== digest) {
      throw new Error(`Remote Agent file checksum mismatch: ${name}`);
    }
    return {
      name,
      path: outPath,
      relativePath: file.relativePath,
      mimeType: file.mimeType,
      size: buffer.byteLength,
      sha256: digest
    };
  });
}

function readTransferFile(filePath, fallbackName, allowedRoots) {
  const resolved = resolveRealFileWithinRoots(filePath, allowedRoots);
  const stat = fs.statSync(resolved);
  assertFileTransferSize(stat.size, stat.size, resolved);
  const buffer = fs.readFileSync(resolved);
  return {
    name: safeFileName(fallbackName || path.basename(resolved), "remote-agent-result"),
    path: resolved,
    size: buffer.byteLength,
    sha256: sha256(buffer),
    contentBase64: buffer.toString("base64")
  };
}

function filesFromCallback(body, allowedRoots) {
  const files = [];
  let total = 0;
  const candidates = [];
  if (body.artifactPath) candidates.push({ path: body.artifactPath });
  if (body.logPath && body.logPath !== body.artifactPath) candidates.push({ path: body.logPath });
  if (Array.isArray(body.files)) {
    for (const item of body.files) candidates.push(item);
  }
  const seenPaths = new Set();
  for (const item of candidates) {
    if (item?.contentBase64) {
      const buffer = Buffer.from(String(item.contentBase64), "base64");
      total += buffer.byteLength;
      assertFileTransferSize(buffer.byteLength, total, item.name || item.path || "inline result");
      files.push({
        name: safeFileName(item.name || item.path || `result-${files.length + 1}`, `result-${files.length + 1}`),
        relativePath: item.relativePath,
        mimeType: item.mimeType,
        size: buffer.byteLength,
        sha256: item.sha256 || sha256(buffer),
        contentBase64: buffer.toString("base64")
      });
      continue;
    }
    if (item?.path) {
      const resolvedPath = path.resolve(String(item.path));
      if (seenPaths.has(resolvedPath)) continue;
      seenPaths.add(resolvedPath);
      const file = readTransferFile(item.path, item.name, allowedRoots);
      total += file.size;
      assertFileTransferSize(file.size, total, item.path);
      files.push(file);
    }
  }
  return files;
}

function tryListenServer(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function listenServerFrom(server, startPort, host) {
  for (let port = startPort; port <= 65535; port += 1) {
    try {
      await tryListenServer(server, port, host);
      const loopbackOk = await verifyLoopbackControlPort(port);
      if (!loopbackOk) {
        console.warn(`Remote Agent control port ${port} is not reachable on 127.0.0.1 by this bridge; trying next port.`);
        await closeServer(server);
        continue;
      }
      return port;
    } catch (error) {
      if (error?.code !== "EADDRINUSE" && error?.code !== "EACCES") throw error;
    }
  }
  throw new Error(`No available control port found from ${startPort}.`);
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function verifyLoopbackControlPort(port) {
  return new Promise((resolve) => {
    const request = http.get({
      hostname: "127.0.0.1",
      port,
      path: "/health",
      timeout: 1000
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(body?.device?.deviceId === deviceId);
        } catch {
          resolve(false);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

function bindUdp(socket, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      socket.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      socket.off("error", onError);
      resolve(port);
    };
    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind(port, "0.0.0.0");
  });
}

async function bindDiscoverySocket() {
  const end = Math.max(discoveryPortStart, discoveryPortEnd);
  for (let port = discoveryPortStart; port <= end; port += 1) {
    const socket = dgram.createSocket("udp4");
    try {
      await bindUdp(socket, port);
      socket.setBroadcast(true);
      return { socket, port };
    } catch (error) {
      try { socket.close(); } catch { /* ignore */ }
      if (error?.code !== "EADDRINUSE" && error?.code !== "EACCES") throw error;
    }
  }
  throw new Error(`Remote Agent discovery port range ${discoveryPortStart}-${end} is occupied.`);
}

async function connectCodexAppServer() {
  if (!codexClient) {
    codexClient = new CodexAppServerClient({
      cwd: defaultCwd,
      logDir: path.join(fileStoreDir, "logs"),
      version: bridgeVersion,
      onNotification: (message) => {
        const closedTasks = taskLifecycle.handleNotification(message);
        if (message.method === "error" && message.params?.willRetry !== true && closedTasks === 0) {
          console.error(`Codex terminal error without a registered remote turn: ${JSON.stringify(message.params?.error || message.params)}`);
        }
      },
      onExit: (error) => {
        cachedDefaultModel = "";
        const failedTasks = taskLifecycle.handleAppServerExit(error);
        console.error(`Codex app-server exited; ${failedTasks} active remote task(s) were failed: ${error.message}`);
      }
    });
  }
  await codexClient.start();
  return codexClient;
}

async function codexRequest(method, params) {
  return (await connectCodexAppServer()).request(method, params);
}

async function resolveDefaultModel() {
  if (cachedDefaultModel) return cachedDefaultModel;
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const result = await codexRequest("model/list", { cursor, limit: 100, includeHidden: true });
    const selected = (result?.data || []).find((item) => item?.isDefault === true);
    const model = String(selected?.model || selected?.id || "").trim();
    if (model) {
      cachedDefaultModel = model;
      return model;
    }
    cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
    if (!cursor) break;
  }
  throw new Error("Codex runtime did not report a default model from model/list.");
}

async function ensureThread(threadName, cwd) {
  if (!threadCoordinator) {
    threadCoordinator = new CodexThreadCoordinator({
      request: codexRequest,
      resolveModel: resolveDefaultModel,
      lifecycle: taskLifecycle,
      resumedTurnWaitMs,
      developerInstructions: "你是一个由 RabiRoute 远端 Agent bridge 调用的下游 Agent。只在允许的工作目录内执行；bridge 会通过 app-server turn 事件跟踪最终状态，本地回调只用于可选的详细进度和文件。",
      onBusyThread: ({ threadId, turnId, terminal }) => {
        console.warn(`Remote Agent will not reuse busy Codex thread ${threadId}; active turn ${turnId} did not reach a reusable terminal state (${terminal.turnStatus || terminal.status}).`);
      }
    });
  }
  return threadCoordinator.ensureThread(threadName, cwd);
}

function buildTaskPrompt(task, localFiles = []) {
  const callbackUrl = `http://127.0.0.1:${actualControlPort}/v1/remote-agent/task-events`;
  const fileLines = localFiles.length
    ? [
        "",
        "[随任务传入的文件]",
        ...localFiles.map((file, index) => `${index + 1}. ${file.name} (${file.size} bytes, sha256=${file.sha256})：${file.path}`)
      ]
    : [];
  return [
    "[RabiRoute 远端 Agent 任务]",
    `任务 ID：${task.taskId}`,
    `任务类型：${task.taskKind || "remote-agent-task"}`,
    `回调 API：${callbackUrl}`,
    "",
    "请执行以下任务。最终答案必须直接写在本 turn 的最终 agentMessage 中；bridge 会从 app-server turn/completed 自动提取并回传，不依赖网络回调。",
    "只有已启用网络且需要额外进度或附件时才选择性 POST 到回调 API；若 sandbox 禁止网络，不要为回调放宽权限。",
    "回调 JSON 示例：",
    JSON.stringify({
      taskId: task.taskId,
      status: "completed",
      summary: "任务完成摘要",
      artifactPath: "可选：产物路径",
      logPath: "可选：日志路径",
      files: [{ path: "可选：需要回传给主控端的本机文件路径" }]
    }, null, 2),
    ...fileLines,
    "",
    "[任务正文]",
    task.message
  ].join("\n");
}

async function deliverToCodex(task, localFiles = [], cwd) {
  const threadName = task.threadName || defaultThreadName;
  await connectCodexAppServer();
  const model = await resolveDefaultModel();
  const threadId = await ensureThread(threadName, cwd);
  const result = await codexRequest("turn/start", {
    threadId,
    clientUserMessageId: stableClientMessageId(task.taskId),
    input: [{ type: "text", text: buildTaskPrompt(task, localFiles), text_elements: [] }],
    cwd,
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: allowNetwork,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    },
    model
  });
  const turnId = String(result?.turn?.id || "").trim();
  if (!turnId) throw new Error(`turn/start did not return turn id: ${JSON.stringify(result)}`);
  return { threadId, turnId, threadName, cwd };
}

function threadTargetKey(threadName, cwd) {
  const comparableCwd = process.platform === "win32" ? cwd.toLowerCase() : cwd;
  return `${comparableCwd}\0${threadName}`;
}

async function executeTask(task, taskId, cwd) {
  try {
    if (taskLifecycle.isTerminal(taskId)) return;
    taskCwdById.set(taskId, cwd);
    const localFiles = materializeTaskFiles(task);
    const delivered = await deliverToCodex(task, localFiles, cwd);
    taskLifecycle.registerTurn({ taskId, turnId: delivered.turnId, threadId: delivered.threadId });
    sendTaskEvent({ taskId, status: "progress", summary: "Task injected into remote Codex thread.", data: { ...delivered, files: localFiles } });
    const terminal = await taskLifecycle.waitForTaskTerminal(taskId, taskTerminalTimeoutMs);
    if (terminal.status === "timeout") {
      sendTaskEvent({
        taskId,
        status: "failed",
        error: terminal.error,
        summary: "Remote Codex task exceeded its terminal-state timeout; its thread will not be reused while that turn remains active."
      });
    }
  } catch (error) {
    sendTaskEvent({ taskId, status: "failed", error: error instanceof Error ? error.message : String(error) });
  } finally {
    taskCwdById.delete(taskId);
  }
}

async function handleTask(task) {
  const taskId = String(task?.taskId || "").trim();
  if (!taskId) {
    console.error("Remote Agent received a task without taskId; the task was rejected.");
    return;
  }
  try {
    sendTaskEvent({ taskId, status: "started", summary: "Remote bridge received task and is waiting for an exclusive Codex thread turn." });
    if (agentType !== "codex") {
      throw new Error(`Unsupported REMOTE_AGENT_TYPE: ${agentType}. This bridge currently implements codex.`);
    }
    const cwd = resolveTaskCwd(task.cwd);
    const threadName = String(task.threadName || defaultThreadName);
    await threadTaskQueue.run(threadTargetKey(threadName, cwd), () => executeTask(task, taskId, cwd));
  } catch (error) {
    taskCwdById.delete(taskId);
    sendTaskEvent({ taskId, status: "failed", error: error instanceof Error ? error.message : String(error) });
  }
}

function createControlServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${actualControlPort || controlPortStart}`}`);
      if (request.method === "GET" && url.pathname === "/health") {
        jsonResponse(response, 200, {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          device: deviceInfo(),
          connected: managerSocket?.readyState === WebSocket.OPEN,
          manager: managerInfo,
          controlPort: actualControlPort,
          discoveryPort,
          discoveryWarning
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        htmlResponse(response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/remote-agent/task-events") {
        if (!localRemoteAddress(request.socket.remoteAddress)) {
          jsonResponse(response, 403, { ok: false, error: "Task event callback only accepts local requests." });
          return;
        }
        const body = await readJson(request);
        const taskId = String(body?.taskId || "").trim();
        if (!taskId) {
          jsonResponse(response, 400, { ok: false, error: "Task event callback requires taskId." });
          return;
        }
        if (taskLifecycle.isTerminal(taskId)) {
          jsonResponse(response, 202, { ok: true, duplicate: true });
          return;
        }
        const taskCwd = taskCwdById.get(taskId);
        if (!taskCwd) {
          jsonResponse(response, 404, { ok: false, error: "Remote Agent callback task is not active on this bridge." });
          return;
        }
        const files = filesFromCallback(body, [taskCwd]);
        const accepted = sendTaskEvent(files.length ? { ...body, taskId, files } : { ...body, taskId });
        jsonResponse(response, 202, { ok: true, duplicate: !accepted });
        return;
      }
      jsonResponse(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      jsonResponse(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: Math.max(totalFileLimitBytes * 2, 1024 * 1024) });
  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (requestUrl.pathname !== "/api/remote-agent/control") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      let authenticated = false;
      const authNonce = randomBytes(32).toString("base64url");
      const authTimer = setTimeout(() => {
        if (!authenticated) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", error: "Password handshake timed out." }));
          ws.close();
        }
      }, 5000);
      ws.send(JSON.stringify({
        type: "challenge",
        protocolVersion: PROTOCOL_VERSION,
        algorithm: "hmac-sha256",
        nonce: authNonce
      }));
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (!authenticated) {
            if (msg.type !== "hello" || msg.protocolVersion !== PROTOCOL_VERSION || !managerAuthProofMatches(msg.proof, authNonce)) {
              ws.send(JSON.stringify({ type: "error", error: "Invalid remote Agent protocol or password." }));
              ws.close();
              return;
            }
            authenticated = true;
            clearTimeout(authTimer);
            if (managerSocket && managerSocket !== ws) {
              try { managerSocket.close(); } catch { /* ignore */ }
            }
            managerSocket = ws;
            managerInfo = msg.manager || null;
            ws.send(JSON.stringify({
              type: "registered",
              protocolVersion: PROTOCOL_VERSION,
              serverProof: serverAuthProof(authNonce),
              device: deviceInfo(),
              managerTime: new Date().toISOString()
            }));
            flushPendingTaskEvents();
            return;
          }
          if (msg.type === "task") {
            void handleTask(msg.task).catch((error) => {
              console.error(`Remote Agent task handler failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        } catch (error) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : String(error) }));
          }
        }
      });
      ws.on("close", () => {
        clearTimeout(authTimer);
        if (managerSocket === ws) {
          managerSocket = null;
          managerInfo = null;
        }
      });
      ws.on("error", (error) => {
        clearTimeout(authTimer);
        console.error(`Remote Agent control socket error: ${error.message}`);
      });
    });
  });
  return server;
}

async function startDiscoveryResponder() {
  let socket = null;
  try {
    const bound = await bindDiscoverySocket();
    socket = bound.socket;
    discoveryPort = bound.port;
  } catch (error) {
    discoveryWarning = error instanceof Error ? error.message : String(error);
    console.warn(discoveryWarning);
    return;
  }
  socket.on("message", (message, remote) => {
    let payload = {};
    try {
      payload = JSON.parse(message.toString("utf8"));
    } catch {
      return;
    }
    if (payload.type !== "rabiroute.remoteAgent.client.discover") return;
    const publicEndpoint = publicControlUrl ? new URL(publicControlUrl) : null;
    const host = publicEndpoint?.hostname || publicHost || firstLocalIp();
    const advertisedPort = publicEndpoint
      ? Number(publicEndpoint.port || (publicEndpoint.protocol === "wss:" ? 443 : 80))
      : actualControlPort;
    const response = Buffer.from(JSON.stringify({
      type: "rabiroute.remoteAgent.client",
      protocolVersion: PROTOCOL_VERSION,
      device: deviceInfo(),
      host,
      port: advertisedPort,
      controlUrl: publicControlUrl || `ws://${host}:${actualControlPort}/api/remote-agent/control`,
      publicControlUrl: Boolean(publicControlUrl),
      discoveryPort,
      passwordRequired: true,
      sentAt: new Date().toISOString()
    }));
    socket.send(response, remote.port, remote.address);
  });
  console.log(`Remote Agent discovery listening on udp://0.0.0.0:${discoveryPort}`);
}

const server = createControlServer();
actualControlPort = await listenServerFrom(server, controlPortStart, controlHost);
console.log(`Remote Agent control listening on http://${controlHost}:${actualControlPort}`);
console.log(`Remote Agent password: ${configuredPassword ? "set by REMOTE_AGENT_PASSWORD" : `${password} (generated for this process)`}`);
await startDiscoveryResponder();

process.once("exit", () => codexClient?.close());

// event-driven-allow: transport heartbeat keepalive; no business queue or file state is queried.
setInterval(() => {
  try {
    if (managerSocket?.readyState === WebSocket.OPEN) {
      managerSocket.send(JSON.stringify({ type: "heartbeat", device: deviceInfo() }));
    }
  } catch {
    // next manager connection will refresh state
  }
}, 15000).unref();
