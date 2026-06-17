import fs from "node:fs";
import http from "node:http";
import dgram from "node:dgram";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";

const PROTOCOL_VERSION = 2;
const DEFAULT_PASSWORD = "123456";
const controlHost = process.env.REMOTE_AGENT_CONTROL_HOST || "0.0.0.0";
const controlPortStart = Number(process.env.REMOTE_AGENT_CONTROL_PORT || "8797");
const discoveryPortStart = Number(process.env.REMOTE_AGENT_DISCOVERY_PORT_START || process.env.REMOTE_AGENT_DISCOVERY_PORT || "8798");
const discoveryPortEnd = Number(process.env.REMOTE_AGENT_DISCOVERY_PORT_END || "8818");
const password = process.env.REMOTE_AGENT_PASSWORD || DEFAULT_PASSWORD;
const deviceId = process.env.REMOTE_AGENT_DEVICE_ID || os.hostname();
const deviceName = process.env.REMOTE_AGENT_DEVICE_NAME || os.hostname();
const agentType = process.env.REMOTE_AGENT_TYPE || "codex";
const defaultCwd = process.env.REMOTE_AGENT_DEFAULT_CWD || process.cwd();
const defaultThreadName = process.env.REMOTE_AGENT_DEFAULT_THREAD || "Remote Agent";
const codexAppServerUrl = process.env.REMOTE_AGENT_CODEX_APP_SERVER_URL || "ws://127.0.0.1:4510";
const codexBin = process.env.REMOTE_AGENT_CODEX_BIN || "codex";
const publicHost = process.env.REMOTE_AGENT_PUBLIC_HOST || "";

let actualControlPort = 0;
let discoveryPort = 0;
let discoveryWarning = "";
let managerSocket = null;
let managerInfo = null;
let appSocket = null;
let appNextId = 1;
const appPending = new Map();

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
      <p>默认密码：<code>${password === DEFAULT_PASSWORD ? DEFAULT_PASSWORD : "已通过 REMOTE_AGENT_PASSWORD 覆盖"}</code></p>
      <p>控制端口：<code>${actualControlPort || "-"}</code></p>
      <p>发现端口：<code>${discoveryPort || discoveryWarning || "-"}</code></p>
    </main>
  </body>
  </html>`);
}

function sendToManager(payload) {
  if (!managerSocket || managerSocket.readyState !== WebSocket.OPEN) {
    throw new Error("Remote Agent bridge is not connected to RabiRoute manager.");
  }
  managerSocket.send(JSON.stringify(payload));
}

function sendTaskEvent(event) {
  sendToManager({ type: "taskEvent", ...event, device: deviceInfo() });
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
      return port;
    } catch (error) {
      if (error?.code !== "EADDRINUSE" && error?.code !== "EACCES") throw error;
    }
  }
  throw new Error(`No available control port found from ${startPort}.`);
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
  const callbackUrl = `http://127.0.0.1:${actualControlPort}/v1/remote-agent/task-events`;
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
        sendTaskEvent(body);
        jsonResponse(response, 202, { ok: true });
        return;
      }
      jsonResponse(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      jsonResponse(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (requestUrl.pathname !== "/api/remote-agent/control") return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      let authenticated = false;
      const authTimer = setTimeout(() => {
        if (!authenticated) {
          ws.send(JSON.stringify({ type: "error", error: "Password handshake timed out." }));
          ws.close();
        }
      }, 5000);
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (!authenticated) {
            if (msg.type !== "hello" || String(msg.password || "") !== password) {
              ws.send(JSON.stringify({ type: "error", error: "Invalid remote Agent password." }));
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
              device: deviceInfo(),
              managerTime: new Date().toISOString()
            }));
            return;
          }
          if (msg.type === "task") {
            void handleTask(msg.task);
          }
        } catch (error) {
          ws.send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : String(error) }));
        }
      });
      ws.on("close", () => {
        if (managerSocket === ws) {
          managerSocket = null;
          managerInfo = null;
        }
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
    const host = publicHost || firstLocalIp();
    const response = Buffer.from(JSON.stringify({
      type: "rabiroute.remoteAgent.client",
      protocolVersion: PROTOCOL_VERSION,
      device: deviceInfo(),
      host,
      port: actualControlPort,
      controlUrl: `ws://${host}:${actualControlPort}/api/remote-agent/control`,
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
console.log(`Remote Agent password: ${password === DEFAULT_PASSWORD ? "123456 (default)" : "set by REMOTE_AGENT_PASSWORD"}`);
await startDiscoveryResponder();

setInterval(() => {
  try {
    if (managerSocket?.readyState === WebSocket.OPEN) {
      managerSocket.send(JSON.stringify({ type: "heartbeat", device: deviceInfo() }));
    }
  } catch {
    // next manager connection will refresh state
  }
}, 15000).unref();
