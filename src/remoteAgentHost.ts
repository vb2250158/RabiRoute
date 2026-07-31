import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { handleAgentThreadRequest, type AgentThreadRequest } from "./agentThreads.js";
import { listCodexDesktopThreads } from "./codexDesktopBridge.js";
import {
  deployAstrbotAdapter,
  getCopilotStatus,
  openMarvis,
  scanAgentAdapters,
  testAstrbotLogin,
  type AgentManagerApiContext,
  type AstrbotLoginTestRequest,
  type MarvisOpenRequest
} from "./agentAdapters/managerApi.js";
import { rabiRoutePackageVersion } from "./packageInfo.js";
import type { RemoteAgentTask, RemoteAgentTaskEvent } from "./messageEndpoints/remoteAgentProtocol.js";
import { RemoteAgentHostBridge } from "./remoteAgentHost/bridge.js";
import {
  RemoteAgentHostConfigStore,
  type RemoteAgentHostSettingsPatch,
  type RemoteAgentProfile
} from "./remoteAgentHost/configStore.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = process.env.RABIROUTE_REMOTE_AGENT_HOST_CONFIG?.trim()
  || path.join(process.env.LOCALAPPDATA || os.homedir(), "RabiRoute", "RemoteAgent", "config.json");
const configStore = new RemoteAgentHostConfigStore(defaultConfigPath);
const webuiDistPath = path.join(rootDir, "ribiwebgui", "dist");
const agentWorkerEntrypoint = path.join(rootDir, "dist", "remoteAgentHost", "agentWorker.js");
const taskFilesRoot = path.join(path.dirname(defaultConfigPath), "task-files");
const activeTasks = new Map<string, RemoteAgentTask>();
const managerEventStreams = new Set<http.ServerResponse>();
let bridge: RemoteAgentHostBridge;

function jsonResponse(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2 * 1024 * 1024) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
}

function syntheticGateway(profile = configStore.read().profile): Record<string, unknown> {
  return {
    id: "remote-agent",
    configName: "remote-agent",
    name: "Remote Agent",
    enabled: configStore.read().enabled,
    messageAdapterType: "remoteAgent",
    messageAdapters: ["remoteAgent"],
    messageAdapterPolicies: {
      remoteAgent: {
        inputEnabled: true,
        outputEnabled: true,
        supportedOutputs: ["text", "image", "voice", "file"]
      }
    },
    gatewayPort: 8789,
    agentRoleId: "",
    agentRoleFile: "persona.md",
    notificationRules: [],
    ...profile
  };
}

function gatewayPayload(): Record<string, unknown> {
  const definition = syntheticGateway();
  return {
    code: 0,
    data: {
      config: { gateways: [definition] },
      manager: [{
        id: "remote-agent",
        definition,
        enabled: true,
        running: true,
        messageAdapter: { type: "remoteAgent", status: "running", message: "轻量 Remote Agent 消息端已启动。" },
        agentAdapters: {}
      }],
      configFiles: {
        "remote-agent": {
          adapter: configStore.configPath
        }
      }
    }
  };
}

function profileFromGateway(value: unknown): RemoteAgentProfile {
  const gateway = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return gateway as RemoteAgentProfile;
}

function agentManagerContext(): AgentManagerApiContext {
  const definition = syntheticGateway(configStore.read().profile);
  const cwdOptions = allowedCodexWorkspaces();
  return {
    rootDir,
    getRuntimes: () => [{ definition }],
    cwdOptions,
    projects: cwdOptions.map(projectPath => ({
      id: projectPath,
      label: path.basename(projectPath) || projectPath,
      path: projectPath,
      exists: fs.existsSync(projectPath)
    })),
    checkHttpEndpoint: async (url, timeoutMs = 1_500) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal });
        return response.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
    resolveWingetCopilot
  };
}

function resolveWingetCopilot(): string | null {
  if (!process.env.LOCALAPPDATA) return null;
  const base = path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
  try {
    for (const entry of fs.readdirSync(base)) {
      if (!entry.startsWith("GitHub.Copilot")) continue;
      const executable = path.join(base, entry, "copilot.exe");
      if (fs.existsSync(executable)) return executable;
    }
  } catch {
    // PATH fallback remains available.
  }
  return null;
}

function allowedCodexWorkspaces(): string[] {
  const configured = configStore.read().profile.codexCwd?.trim();
  let discovered: string[] = [];
  try {
    discovered = listCodexDesktopThreads({ limit: 10_000 })
      .map(thread => thread.cwd?.trim())
      .filter((value): value is string => Boolean(value));
  } catch {
    // Desktop may be closed; configured paths remain available.
  }
  return [...new Set([configured, ...discovered].filter((value): value is string => Boolean(value)).map(value => path.resolve(value)))];
}

function autoSelectOnlyCodexSession(): void {
  const config = configStore.read();
  if (!config.profile.agentAdapters.includes("codex") || config.profile.codexCwd?.trim()) return;
  try {
    const sessions = listCodexDesktopThreads({ limit: 2 }).filter(session => !session.archived && session.cwd?.trim());
    if (sessions.length !== 1) return;
    const session = sessions[0];
    configStore.updateProfile({
      ...config.profile,
      codexThreadId: session.id,
      codexThreadName: session.title,
      codexCwd: session.cwd
    });
  } catch {
    // Desktop absence remains visible in the normal Agent scan state.
  }
}

function hostEnvironment(profile: RemoteAgentProfile): NodeJS.ProcessEnv {
  const cwd = profile.codexCwd?.trim() || rootDir;
  return {
    ...process.env,
    GATEWAY_ID: "remote-agent",
    GATEWAY_MANAGER_PORT: String(configStore.read().port),
    GATEWAY_MANAGER_URL: `http://127.0.0.1:${configStore.read().port}`,
    MESSAGE_ADAPTER_TYPE: "remoteAgent",
    MESSAGE_ADAPTER_TYPES: JSON.stringify(["remoteAgent"]),
    AGENT_ADAPTERS: profile.agentAdapters.join(","),
    AGENT_MODEL: profile.agentModel?.trim() || "",
    CODEX_THREAD_ID: profile.codexThreadId?.trim() || "",
    CODEX_THREAD_NAME: profile.codexThreadName?.trim() || "Remote Agent",
    CODEX_CWD: cwd,
    CODEX_PLAN_ASSISTANT_SESSIONS: JSON.stringify(profile.codexPlanAssistantSessions || []),
    COPILOT_THREAD_NAME: profile.copilotThreadName?.trim() || "Remote Agent",
    COPILOT_CWD: profile.copilotCwd?.trim() || cwd,
    COPILOT_CLI_BIN: profile.copilotCliBin?.trim() || resolveWingetCopilot() || "copilot",
    MARVIS_APP_ID: profile.marvisAppId?.trim() || "Tencent.Marvis",
    ASTRBOT_URL: profile.astrbotUrl?.trim() || "http://127.0.0.1:6185",
    ASTRBOT_USERNAME: profile.astrbotUsername?.trim() || "",
    ASTRBOT_PASSWORD: profile.astrbotPassword?.trim() || "",
    ASTRBOT_PROJECT_ID: profile.astrbotProjectId?.trim() || "",
    ASTRBOT_SESSION_ID: profile.astrbotSessionId?.trim() || "",
    DATA_DIR: path.join(path.dirname(defaultConfigPath), "runtime")
  };
}

function safeFileName(value: string, fallback: string): string {
  return path.basename(value).replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_") || fallback;
}

function materializeTaskFiles(task: RemoteAgentTask & { files?: Array<Record<string, unknown>> }): string[] {
  const files = Array.isArray(task.files) ? task.files : [];
  if (!files.length) return [];
  const taskDir = path.join(taskFilesRoot, String(task.taskId).replace(/[^a-zA-Z0-9_-]/g, "_"));
  fs.mkdirSync(taskDir, { recursive: true });
  let total = 0;
  return files.map((file, index) => {
    const content = Buffer.from(String(file.contentBase64 || ""), "base64");
    if (!content.length || content.length > 10 * 1024 * 1024) throw new Error("Remote task attachment is empty or exceeds 10 MiB.");
    total += content.length;
    if (total > 25 * 1024 * 1024) throw new Error("Remote task attachments exceed 25 MiB.");
    const expected = String(file.sha256 || "").trim().toLowerCase();
    const actual = createHash("sha256").update(content).digest("hex");
    if (expected && expected !== actual) throw new Error(`Remote task attachment checksum mismatch: ${String(file.name || index + 1)}`);
    const target = path.join(taskDir, `${String(index + 1).padStart(2, "0")}-${safeFileName(String(file.name || ""), "attachment.bin")}`);
    fs.writeFileSync(target, content);
    return target;
  });
}

function taskPrompt(task: RemoteAgentTask, localFiles: string[]): string {
  const replyContext = {
    targetType: "remote_agent_task",
    adapterType: "remoteAgent",
    remoteAgentTaskId: task.taskId,
    remoteAgentDeviceId: configStore.read().deviceId,
    originGatewayId: task.originGatewayId,
    originReplyContext: task.originReplyContext
  };
  return [
    "<RabiRemoteAgentTask>",
    `任务 ID：${task.taskId}`,
    task.taskKind ? `任务类型：${task.taskKind}` : "",
    localFiles.length ? `本机附件：\n${localFiles.map(file => `- ${file}`).join("\n")}` : "",
    "",
    task.message,
    "",
    "完成后必须把最终结果回传给 RabiRoute，不能只留在当前 Agent 会话。",
    `普通回复 API：http://127.0.0.1:${configStore.read().port}/api/agent/replies`,
    `replyContext：${JSON.stringify(replyContext)}`,
    "请求体：{\"text\":\"最终结果\",\"replyContext\":<上面的 JSON>}。需要返回文件时同时传 filePath。",
    "</RabiRemoteAgentTask>"
  ].filter(Boolean).join("\n");
}

async function deliverTask(task: RemoteAgentTask & { files?: Array<Record<string, unknown>> }): Promise<void> {
  const profile = configStore.read().profile;
  if (!profile.agentAdapters.length) throw new Error("尚未配置任何 Agent 端。");
  if (profile.agentAdapters.includes("codex") && !profile.codexCwd?.trim()) {
    throw new Error("Codex Agent 尚未选择工作目录；请先在 Remote Agent WebGUI 从扫描结果中选择项目。");
  }
  if (profile.agentAdapters.includes("copilotCli") && !profile.copilotCwd?.trim()) {
    throw new Error("Copilot CLI 尚未选择工作目录；请先在 Remote Agent WebGUI 从扫描结果中选择项目。");
  }
  if (!fs.existsSync(agentWorkerEntrypoint)) throw new Error(`Agent runtime is missing: ${agentWorkerEntrypoint}`);
  const localFiles = materializeTaskFiles(task);
  const message = taskPrompt(task, localFiles);
  const encoded = encodeURIComponent(message);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [agentWorkerEntrypoint, `--message=${encoded}`], {
      cwd: rootDir,
      env: hostEnvironment(profile),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      reject(new Error("Agent delivery timed out."));
    }, 10 * 60 * 1000);
    child.stdout.on("data", chunk => { output += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { output += chunk.toString("utf8"); });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(output.trim() || `Agent delivery failed with exit code ${code}.`));
    });
  });
}

function returnedFiles(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidate = String(body.filePath || (body.payload as Record<string, unknown> | undefined)?.filePath || "").trim();
  if (!candidate) return [];
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Returned file does not exist: ${resolved}`);
  const content = fs.readFileSync(resolved);
  if (content.length > 10 * 1024 * 1024) throw new Error("Returned file exceeds 10 MiB.");
  return [{
    name: path.basename(resolved),
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    contentBase64: content.toString("base64")
  }];
}

function publishEvent(type: string, data: unknown): void {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const stream of [...managerEventStreams]) {
    if (stream.writableEnded || stream.destroyed) managerEventStreams.delete(stream);
    else stream.write(frame);
  }
}

async function installCopilot(response: http.ServerResponse): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const result = await promisify(execFile)("npm", ["install", "-g", "@github/copilot"], {
      shell: true,
      timeout: 120_000,
      env: { ...process.env }
    });
    jsonResponse(response, 200, { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
  } catch (error) {
    jsonResponse(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function startCopilotLogin(response: http.ServerResponse): Promise<void> {
  const bin = configStore.read().profile.copilotCliBin?.trim() || resolveWingetCopilot() || "copilot";
  const child = spawn(bin, ["login"], {
    env: { ...process.env },
    shell: process.platform === "win32",
    windowsHide: true
  });
  let output = "";
  let replied = false;
  const finish = (status: number, value: unknown): void => {
    if (replied) return;
    replied = true;
    jsonResponse(response, status, value);
  };
  const inspect = (): void => {
    const code = output.match(/code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1];
    if (code) finish(200, { ok: true, code, url: "https://github.com/login/device", pid: child.pid });
  };
  child.stdout?.on("data", chunk => { output += chunk.toString(); inspect(); });
  child.stderr?.on("data", chunk => { output += chunk.toString(); inspect(); });
  child.on("exit", code => {
    publishEvent("copilot_login_status", { done: code === 0, exitCode: code, error: code === 0 ? "" : output.trim() });
    finish(code === 0 ? 200 : 500, code === 0 ? { ok: true, done: true } : { ok: false, error: output.trim() });
  });
  setTimeout(() => {
    if (!replied) {
      try { child.kill(); } catch { /* best effort */ }
      finish(408, { ok: false, error: "Timeout waiting for device code" });
    }
  }, 15_000).unref();
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".svg") return "image/svg+xml; charset=utf-8";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

function serveStatic(pathname: string, response: http.ServerResponse): boolean {
  const indexPath = path.join(webuiDistPath, "index.html");
  if (!fs.existsSync(indexPath)) return false;
  const relative = path.normalize(decodeURIComponent(pathname === "/" ? "/index.html" : pathname)).replace(/^[/\\]+/, "");
  const candidate = path.resolve(webuiDistPath, relative);
  if (path.relative(webuiDistPath, candidate).startsWith("..")) return false;
  const packagedBrandAsset = relative === path.join("assets", "rabiroute-icon.png")
    || relative === path.join("assets", "rabiroute-mini-badge.svg")
    ? path.join(rootDir, relative)
    : "";
  const filePath = fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : packagedBrandAsset && fs.existsSync(packagedBrandAsset)
      ? packagedBrandAsset
      : indexPath;
  response.writeHead(200, { "content-type": contentType(filePath) });
  response.end(fs.readFileSync(filePath));
  return true;
}

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const remoteAddress = request.socket.remoteAddress || "";
  const isLoopback = remoteAddress === "127.0.0.1"
    || remoteAddress === "::1"
    || remoteAddress === "::ffff:127.0.0.1";
  if (!isLoopback) {
    jsonResponse(response, 403, { code: 1, error: "Remote Agent settings are available only on this computer." });
    return;
  }
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    jsonResponse(response, 200, { ok: true, mode: "remote-agent-host", ...bridge.status() });
    return;
  }
  if (request.method === "GET" && url.pathname === "/meta") {
    const config = configStore.read();
    jsonResponse(response, 200, {
      version: rabiRoutePackageVersion(),
      githubUrl: "https://github.com/vb2250158/RabiRoute",
      managerPort: config.port,
      runtimeMode: "remote-agent-host",
      computerName: os.hostname()
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/gateways") {
    jsonResponse(response, 200, gatewayPayload());
    return;
  }
  if (request.method === "POST" && url.pathname === "/gateways") {
    const body = await readJsonBody<{ gateways?: unknown[] }>(request);
    const profile = profileFromGateway(body.gateways?.[0]);
    configStore.updateProfile(profile);
    jsonResponse(response, 200, gatewayPayload());
    return;
  }
  if (request.method === "GET" && url.pathname === "/network-options") {
    jsonResponse(response, 200, { code: 0, data: { adapters: {}, localAddresses: [], httpServers: [], websocketClients: [] } });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/remote-agent-host/settings") {
    jsonResponse(response, 200, { code: 0, settings: configStore.read(), status: bridge.status() });
    return;
  }
  if (request.method === "PATCH" && url.pathname === "/api/remote-agent-host/settings") {
    const before = configStore.read();
    const settings = configStore.patchSettings(await readJsonBody<RemoteAgentHostSettingsPatch>(request));
    if (!settings.enabled || settings.password !== before.password) {
      bridge.disconnectManager("Remote Agent password or availability changed.");
    }
    jsonResponse(response, 200, { code: 0, settings, status: bridge.status(), restartRequired: false });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/scan/agents") {
    jsonResponse(response, 200, await scanAgentAdapters(agentManagerContext()));
    return;
  }
  if (url.pathname === "/api/agent/threads" && (request.method === "GET" || request.method === "POST")) {
    const body = request.method === "GET"
      ? Object.fromEntries(url.searchParams.entries()) as AgentThreadRequest
      : await readJsonBody<AgentThreadRequest>(request);
    const result = await handleAgentThreadRequest(body, {
      allowedWorkspaces: allowedCodexWorkspaces(),
      defaultWorkspace: configStore.read().profile.codexCwd || rootDir
    });
    jsonResponse(response, result.statusCode, { code: 0, ...result.data });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive"
    });
    response.write("event: ready\ndata: {}\n\n");
    managerEventStreams.add(response);
    request.once("close", () => managerEventStreams.delete(response));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/agent/copilot-status") {
    jsonResponse(response, 200, await getCopilotStatus(agentManagerContext()));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/agent/copilot-install") {
    await installCopilot(response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/agent/copilot-login") {
    await startCopilotLogin(response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/agent/marvis-open") {
    jsonResponse(response, 200, openMarvis(agentManagerContext(), await readJsonBody<MarvisOpenRequest>(request)));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/agent/astrbot-login-test") {
    const result = await testAstrbotLogin(await readJsonBody<AstrbotLoginTestRequest>(request));
    jsonResponse(response, result.ok ? 200 : 400, result);
    return;
  }
  if (
    request.method === "POST"
    && (url.pathname === "/api/deploy-astrbot-adapter" || url.pathname === "/api/agent/astrbot-deploy")
  ) {
    const result = await deployAstrbotAdapter(agentManagerContext());
    jsonResponse(response, result.status, result.body);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/agent/replies") {
    const body = await readJsonBody<Record<string, unknown>>(request);
    const context = body.replyContext && typeof body.replyContext === "object"
      ? body.replyContext as Record<string, unknown>
      : {};
    const taskId = String(context.remoteAgentTaskId || body.taskId || "").trim();
    if (!taskId || !activeTasks.has(taskId)) throw new Error("Remote Agent reply does not reference an active task.");
    const text = String(body.text || body.message || body.content || "").trim();
    const event: RemoteAgentTaskEvent = {
      taskId,
      status: body.status === "failed" ? "failed" : "completed",
      summary: text || "远端 Agent 已完成任务。",
      message: text,
      error: body.status === "failed" ? text : undefined,
      files: returnedFiles(body) as RemoteAgentTaskEvent["files"]
    };
    if (!bridge.sendTaskEvent(event)) throw new Error("Remote Agent result could not be sent to the primary Manager.");
    activeTasks.delete(taskId);
    jsonResponse(response, 202, { code: 0, ok: true, status: "sent", taskId });
    return;
  }
  if (request.method === "POST" && url.pathname === "/open-config-file") {
    jsonResponse(response, 200, { code: 0, message: "Remote Agent 配置仅通过当前页面维护。", path: configStore.configPath });
    return;
  }
  if (serveStatic(url.pathname, response)) return;
  jsonResponse(response, 404, { code: -1, message: "Not found" });
}

export async function startRemoteAgentHost(): Promise<void> {
  autoSelectOnlyCodexSession();
  const config = configStore.read();
  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch(error => {
      if (!response.headersSent) {
        jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      } else {
        response.end();
      }
    });
  });
  bridge = new RemoteAgentHostBridge({
    configStore,
    server,
    onTask: async task => {
      activeTasks.set(task.taskId, task);
      try {
        await deliverTask(task);
      } catch (error) {
        activeTasks.delete(task.taskId);
        throw error;
      }
    }
  });
  await bridge.start();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.listenHost, () => resolve());
  });
  console.log(`RabiRoute Remote Agent Host listening on http://127.0.0.1:${config.port}`);
}

void startRemoteAgentHost().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
