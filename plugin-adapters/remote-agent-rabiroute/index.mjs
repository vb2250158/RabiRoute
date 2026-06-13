import fs from "node:fs";
import http from "node:http";
import dgram from "node:dgram";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

let managerWsUrl = process.env.RABIROUTE_MANAGER_WS || "";
let token = process.env.REMOTE_AGENT_TOKEN || "";
const deviceId = process.env.REMOTE_AGENT_DEVICE_ID || os.hostname();
const deviceName = process.env.REMOTE_AGENT_DEVICE_NAME || os.hostname();
const agentType = process.env.REMOTE_AGENT_TYPE || "codex";
const defaultCwd = process.env.REMOTE_AGENT_DEFAULT_CWD || process.cwd();
const defaultThreadName = process.env.REMOTE_AGENT_DEFAULT_THREAD || "Remote Agent";
const callbackHost = process.env.REMOTE_AGENT_CALLBACK_HOST || "127.0.0.1";
const callbackPort = Number(process.env.REMOTE_AGENT_CALLBACK_PORT || "8797");
const discoveryPort = Number(process.env.REMOTE_AGENT_DISCOVERY_PORT || "8798");
let autoDiscoverEnabled = process.env.REMOTE_AGENT_AUTO_DISCOVER !== "0";
const codexAppServerUrl = process.env.REMOTE_AGENT_CODEX_APP_SERVER_URL || "ws://127.0.0.1:4510";
const codexBin = process.env.REMOTE_AGENT_CODEX_BIN || "codex";

let socket = null;
let appSocket = null;
let appNextId = 1;
const appPending = new Map();
let discoveredManagers = [];

function firstLocalIp() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) return item.address;
    }
  }
  return "127.0.0.1";
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

function managerUrlWithToken() {
  if (!managerWsUrl) {
    throw new Error("RABIROUTE_MANAGER_WS is not set and no LAN manager has been selected.");
  }
  const url = new URL(managerWsUrl);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

function sendToManager(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("Remote Agent bridge is not connected to RabiRoute manager.");
  }
  socket.send(JSON.stringify(payload));
}

function sendTaskEvent(event) {
  sendToManager({ type: "taskEvent", ...event, device: deviceInfo() });
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

function htmlResponse(response, body) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function bridgePage() {
  const rows = discoveredManagers.map((manager, index) => `
    <tr>
      <td>${manager.name || "RabiRoute Manager"}</td>
      <td><code>${manager.wsUrl}</code></td>
      <td>${manager.tokenRequired ? "需要" : "不需要"}</td>
      <td><button onclick="selectManager(${index})">选择</button></td>
    </tr>
  `).join("");
  return `<!doctype html>
  <html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>远端 Agent Bridge</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 24px; color: #172026; background: #f7f8fa; }
      main { max-width: 980px; margin: auto; background: white; border: 1px solid #dde3ea; border-radius: 8px; padding: 20px; }
      input { width: min(720px, 100%); padding: 8px; margin: 4px 0 12px; }
      button { padding: 7px 12px; margin-right: 8px; cursor: pointer; }
      table { border-collapse: collapse; width: 100%; margin-top: 12px; }
      td, th { border-bottom: 1px solid #e7ebf0; padding: 8px; text-align: left; }
      code { word-break: break-all; }
      .status { color: #496579; margin: 8px 0 16px; }
    </style>
  </head>
  <body>
    <main>
      <h1>远端 Agent Bridge</h1>
      <div class="status">设备：${deviceName} (${deviceId}) · agentType=${agentType} · ${process.platform}/${process.arch}</div>
      <label><input id="autoDiscover" type="checkbox" ${autoDiscoverEnabled ? "checked" : ""} style="width:auto" /> 启用局域网自动发现</label>
      <h2>连接 RabiRoute Manager</h2>
      <label>Manager WebSocket</label><br />
      <input id="managerWsUrl" value="${managerWsUrl}" placeholder="ws://<rabi-host>:8790/api/remote-agent/connect" /><br />
      <label>Token</label><br />
      <input id="token" value="${token}" placeholder="REMOTE_AGENT_TOKEN，可为空" /><br />
      <button onclick="saveConfig()">保存并连接</button>
      <button onclick="scanLan()">扫描局域网</button>
      <h2>发现到的 Manager</h2>
      <table>
        <thead><tr><th>名称</th><th>地址</th><th>Token</th><th></th></tr></thead>
        <tbody>${rows || "<tr><td colspan='4'>尚未发现，点击“扫描局域网”。</td></tr>"}</tbody>
      </table>
    </main>
    <script>
      async function saveConfig() {
        const resp = await fetch('/api/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            managerWsUrl: document.getElementById('managerWsUrl').value,
            token: document.getElementById('token').value,
            autoDiscoverEnabled: document.getElementById('autoDiscover').checked
          })
        });
        if (!resp.ok) alert(await resp.text());
        else location.reload();
      }
      async function scanLan() {
        await fetch('/api/discover', { method: 'POST' });
        location.reload();
      }
      async function selectManager(index) {
        const resp = await fetch('/api/select-manager', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ index })
        });
        if (!resp.ok) alert(await resp.text());
        else location.reload();
      }
    </script>
  </body>
  </html>`;
}

function discoverManagers(timeoutMs = 1400) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const found = [];
    const seen = new Set();
    const probe = Buffer.from(JSON.stringify({ type: "rabiroute.remoteAgent.discover", device: deviceInfo() }));
    const finish = () => {
      socket.close();
      discoveredManagers = found;
      resolve(found);
    };
    socket.on("message", (message, remote) => {
      try {
        const item = JSON.parse(message.toString("utf8"));
        if (item.type !== "rabiroute.remoteAgent.manager" || !item.wsUrl) return;
        const key = item.wsUrl;
        if (seen.has(key)) return;
        seen.add(key);
        found.push({ ...item, remoteAddress: remote.address });
      } catch {
        // ignore malformed response
      }
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(probe, discoveryPort, "255.255.255.255");
    });
    setTimeout(finish, timeoutMs);
  });
}

function startCallbackServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || `${callbackHost}:${callbackPort}`}`);
      if (request.method === "GET" && url.pathname === "/health") {
        jsonResponse(response, 200, { ok: true, device: deviceInfo(), connected: socket?.readyState === WebSocket.OPEN, managerWsUrl, autoDiscoverEnabled, discoveredManagers });
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        htmlResponse(response, bridgePage());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/config") {
        const body = await readJson(request);
        managerWsUrl = String(body.managerWsUrl || "").trim();
        token = String(body.token || "");
        autoDiscoverEnabled = body.autoDiscoverEnabled !== false;
        reconnectManager();
        jsonResponse(response, 200, { ok: true, managerWsUrl, autoDiscoverEnabled });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/discover") {
        const managers = await discoverManagers();
        if (!managerWsUrl && managers[0]?.wsUrl) {
          managerWsUrl = managers[0].wsUrl;
          reconnectManager();
        }
        jsonResponse(response, 200, { ok: true, managers });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/select-manager") {
        const body = await readJson(request);
        const item = discoveredManagers[Number(body.index)];
        if (!item?.wsUrl) throw new Error("Selected manager not found.");
        managerWsUrl = item.wsUrl;
        reconnectManager();
        jsonResponse(response, 200, { ok: true, managerWsUrl });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/remote-agent/task-events") {
        const body = await readJson(request);
        sendTaskEvent(body);
        jsonResponse(response, 202, { ok: true });
        return;
      }
      jsonResponse(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      jsonResponse(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.listen(callbackPort, callbackHost, () => {
    console.log(`Remote Agent callback listening on http://${callbackHost}:${callbackPort}`);
  });
}

async function ensureCodexAppServer(cwd) {
  const url = new URL(codexAppServerUrl);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
    try {
      const health = await fetch(`http://${url.hostname}:${url.port}/healthz`);
      if (health.ok) return;
    } catch {
      // start below
    }
    const out = path.join(os.tmpdir(), "rabiroute-remote-agent-codex-app-server.out.log");
    const err = path.join(os.tmpdir(), "rabiroute-remote-agent-codex-app-server.err.log");
    const child = spawn(codexBin, ["app-server", "--listen", codexAppServerUrl], {
      cwd,
      detached: true,
      shell: process.platform === "win32",
      stdio: ["ignore", fs.openSync(out, "a"), fs.openSync(err, "a")]
    });
    child.unref();
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

async function connectCodexAppServer(cwd) {
  if (appSocket?.readyState === WebSocket.OPEN) return appSocket;
  await ensureCodexAppServer(cwd);
  appSocket = new WebSocket(codexAppServerUrl);
  appSocket.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (typeof msg.id !== "number") return;
    const pending = appPending.get(msg.id);
    if (!pending) return;
    appPending.delete(msg.id);
    if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
    else pending.resolve(msg.result);
  });
  appSocket.on("close", () => { appSocket = null; });
  await new Promise((resolve, reject) => {
    appSocket.once("open", resolve);
    appSocket.once("error", reject);
  });
  await codexRequest("initialize", {
    clientInfo: { name: "rabiroute-remote-agent", title: "RabiRoute Remote Agent", version: "0.1.0" },
    capabilities: { experimentalApi: true }
  });
  return appSocket;
}

function codexRequest(method, params) {
  if (!appSocket || appSocket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Codex app-server is not connected."));
  }
  const id = appNextId++;
  appSocket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (appPending.delete(id)) reject(new Error(`Codex app-server request timed out: ${method}`));
    }, 30000);
    appPending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
  });
}

function sessionIndexPath() {
  return path.join(os.homedir(), ".codex", "session_index.jsonl");
}

function findThreadByName(threadName) {
  const indexPath = sessionIndexPath();
  if (!fs.existsSync(indexPath)) return null;
  const latest = new Map();
  for (const line of fs.readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (typeof item.id !== "string" || typeof item.thread_name !== "string" || typeof item.updated_at !== "string") continue;
      if (item.thread_name !== threadName) continue;
      const existing = latest.get(item.id);
      if (!existing || Date.parse(item.updated_at) > Date.parse(existing.updated_at)) latest.set(item.id, item);
    } catch {
      // skip malformed lines
    }
  }
  return [...latest.values()].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))[0] || null;
}

async function canReadThread(threadId) {
  try {
    await codexRequest("thread/read", { threadId });
    return true;
  } catch {
    return false;
  }
}

async function ensureThread(threadName, cwd) {
  const existing = findThreadByName(threadName);
  if (existing && await canReadThread(existing.id)) return existing.id;
  const result = await codexRequest("thread/start", {
    cwd,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    threadSource: "user",
    sessionStartSource: "startup",
    ephemeral: false,
    developerInstructions: "你是一个由 RabiRoute 远端 Agent bridge 调用的下游 Agent。按任务要求执行，完成后必须调用本地回调 API 回传结果。"
  });
  const threadId = result?.thread?.id;
  if (!threadId) throw new Error(`thread/start did not return thread id: ${JSON.stringify(result)}`);
  await codexRequest("thread/name/set", { threadId, name: threadName });
  return threadId;
}

function buildTaskPrompt(task) {
  const callbackUrl = `http://${callbackHost}:${callbackPort}/v1/remote-agent/task-events`;
  return [
    "[RabiRoute 远端 Agent 任务]",
    `任务 ID：${task.taskId}`,
    `任务类型：${task.taskKind || "remote-agent-task"}`,
    `回调 API：${callbackUrl}`,
    "",
    "请执行以下任务。任务完成、失败或有关键进度时，必须 POST 到回调 API。",
    "回调 JSON 示例：",
    JSON.stringify({
      taskId: task.taskId,
      status: "completed",
      summary: "任务完成摘要",
      artifactPath: "可选：产物路径",
      logPath: "可选：日志路径"
    }, null, 2),
    "",
    "[任务正文]",
    task.message
  ].join("\n");
}

async function deliverToCodex(task) {
  const cwd = task.cwd || defaultCwd;
  const threadName = task.threadName || defaultThreadName;
  await connectCodexAppServer(cwd);
  const threadId = await ensureThread(threadName, cwd);
  await codexRequest("turn/start", {
    threadId,
    input: [{ type: "text", text: buildTaskPrompt(task) }],
    cwd,
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    effort: "high",
    personality: "friendly"
  });
  return { threadId, threadName, cwd };
}

async function handleTask(task) {
  try {
    sendTaskEvent({ taskId: task.taskId, status: "started", summary: "Remote bridge received task and is injecting it into the local Agent." });
    if (agentType !== "codex") {
      throw new Error(`Unsupported REMOTE_AGENT_TYPE: ${agentType}. This bridge currently implements codex.`);
    }
    const delivered = await deliverToCodex(task);
    sendTaskEvent({ taskId: task.taskId, status: "progress", summary: "Task injected into remote Codex thread.", data: delivered });
  } catch (error) {
    sendTaskEvent({ taskId: task.taskId, status: "failed", error: error instanceof Error ? error.message : String(error) });
  }
}

function connectManager() {
  if (!managerWsUrl) {
    console.log("No RabiRoute manager selected yet. Open the bridge UI to scan/select one.");
    return;
  }
  socket = new WebSocket(managerUrlWithToken());
  socket.on("open", () => {
    console.log(`Connected to RabiRoute manager: ${managerWsUrl}`);
    sendToManager({ type: "register", device: deviceInfo() });
  });
  socket.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "task") {
      void handleTask(msg.task);
    } else if (msg.type === "registered") {
      console.log(`Registered remote Agent device ${msg.deviceId}; observedIp=${msg.observedIp || "-"}`);
    } else if (msg.type === "error") {
      console.error(`Manager error: ${msg.error}`);
    }
  });
  socket.on("close", () => {
    console.log("Disconnected from RabiRoute manager; reconnecting soon.");
    setTimeout(connectManager, 3000);
  });
  socket.on("error", (error) => {
    console.error(`Manager connection error: ${error.message}`);
  });
}

function reconnectManager() {
  if (socket) {
    socket.removeAllListeners();
    socket.close();
    socket = null;
  }
  connectManager();
}

startCallbackServer();
if (!managerWsUrl && autoDiscoverEnabled) {
  const managers = await discoverManagers();
  if (managers[0]?.wsUrl) {
    managerWsUrl = managers[0].wsUrl;
  }
}
connectManager();
setInterval(() => {
  try {
    if (socket?.readyState === WebSocket.OPEN) sendToManager({ type: "heartbeat", device: deviceInfo() });
  } catch {
    // reconnect loop handles the socket state
  }
}, 15000).unref();
