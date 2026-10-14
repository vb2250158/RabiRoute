import { createHash, createPublicKey, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexDesktopIpcClient } from "./lib/codex-desktop-ipc.mjs";
import { normalizeDshBinding, sendDshTask } from "./lib/dsh.mjs";
import { runManagerCommand } from "./lib/manager-cli.mjs";
import { createManagerClient } from "./lib/manager-client.mjs";
import { createEndpointSession } from "./lib/endpoint-session.mjs";
import { createDesktopPresentation } from "./lib/desktop-presentation.mjs";
import { TerminalService } from "./lib/terminal-service.mjs";
import { ComputerService } from "./lib/computer-service.mjs";
import { instanceAgents, agentCatalog, configureInstanceAgent, resolveInstanceAgent, registerManagedSession } from "./lib/instance-agents.mjs";
import { normalizeAllowedWorkspaces, resolveRealDirectory, resolveTaskWorkspace } from "./lib/cwd-policy.mjs";

const packageJson = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const AGENT_VERSION = String(packageJson.version || "0.0.0");
const UPDATE_CANDIDATE = process.env.RABI_AGENT_UPDATE_CANDIDATE === "1";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_MS = 15_000;
const TASK_HISTORY_LIMIT = 500;

function homeDataDirectory() {
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "RabiAgent");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "RabiAgent");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "RabiAgent");
}

function configPathFromArgs(args = process.argv.slice(2)) {
  const index = args.indexOf("--config");
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : path.join(homeDataDirectory(), "config.json");
}

function normalizeManagerUrl(value) {
  const url = new URL(String(value || "").trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("RABI_MANAGER_URL must use http:// or https://.");
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("RABI_MANAGER_URL must be an explicit origin without credentials or a path.");
  return url.toString().replace(/\/$/, "");
}

export function managerWebSocketUrl(managerUrl) {
  const url = new URL(normalizeManagerUrl(managerUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/lan-agent/connect`;
  return url.toString();
}

function safeRelativePath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`Invalid Rabi Agent release path: ${value}`);
  }
  return normalized;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function publicKeySha256(publicKey) {
  const der = createPublicKey(publicKey).export({ type: "spki", format: "der" });
  return sha256(der);
}

function normalizedPublicKeySha256(value, field = "RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${field} must be a 64-character SHA-256 hex fingerprint.`);
  return normalized;
}

function manifestPayload(manifest) {
  return JSON.stringify({
    version: manifest.version,
    platform: manifest.platform,
    minNodeVersion: manifest.minNodeVersion,
    files: manifest.files.map(file => ({ path: file.path, sha256: file.sha256, size: file.size, downloadUrl: file.downloadUrl }))
  });
}

export function verifyReleaseManifest(manifest, expectedPublicKeySha256) {
  if (!manifest || manifest.platform !== "node" || !Array.isArray(manifest.files) || !manifest.publicKey || !manifest.publicKeySha256 || !manifest.signature) return false;
  try {
    const expected = normalizedPublicKeySha256(expectedPublicKeySha256, "Rabi Agent configured release public key fingerprint");
    const actual = publicKeySha256(manifest.publicKey);
    if (actual !== expected || manifest.publicKeySha256 !== actual) return false;
    return verify(null, Buffer.from(manifestPayload(manifest)), manifest.publicKey, Buffer.from(manifest.signature, "base64"));
  } catch {
    return false;
  }
}

function versionAtLeast(current, required) {
  const parse = value => String(value || "").replace(/^v/, "").split(".").map(part => Number(part) || 0);
  const [a, b, c] = parse(current);
  const [x, y, z] = parse(required);
  return a > x || (a === x && (b > y || (b === y && c >= z)));
}

function boundedText(value, limit = 12_000) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function randomNodeId() {
  return `${os.hostname().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "rabi-node"}-${Math.random().toString(36).slice(2, 10)}`;
}

function readJson(filePath, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows uses the current-user application-data directory. */ }
}

function parseWorkspaceList(value, fallback) {
  if (!value?.trim()) return [fallback];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Semicolon-separated paths are useful in process environment variables.
  }
  return value.split(";");
}

async function verifyNodeIdentity(config, fetcher = fetch, configPath) {
  const endpoint = await createEndpointSession({ config, configPath, fetchImpl: fetcher }).ensure();
  Object.assign(config, endpoint.config);
  return { guid: endpoint.guid, applicationGenerationId: endpoint.generation, managerInstanceId: endpoint.instance };
}

async function bootstrapConfig(configPath, fetcher = fetch) {
  const previous = readJson(configPath, undefined);
  if (fs.existsSync(configPath) && !previous) throw new Error("The existing instance configuration is invalid; refusing to replace its identity.");
  const managerUrl = normalizeManagerUrl(process.env.RABI_MANAGER_URL || previous?.managerUrl);
  const ticket = String(process.env.RABI_AGENT_BOOTSTRAP_TICKET || "").trim();
  delete process.env.RABI_AGENT_BOOTSTRAP_TICKET;
  // A reconnect never consumes another single-use ticket or replaces existing bindings.
  if (previous?.nodeCredential) {
    const config = { ...previous, managerUrl };
    delete config.lanLinkToken;
    delete config.bootstrapTicket;
    const identity = await verifyNodeIdentity(config, fetcher);
    const nextConfig = { ...config, managerGuid: identity.guid, applicationGenerationId: identity.applicationGenerationId, managerInstanceId: identity.managerInstanceId };
    writePrivateJson(configPath, nextConfig);
    return nextConfig;
  }
  if (!ticket) throw new Error(previous?.lanLinkToken ? "Legacy lanLinkToken is not accepted; re-enroll using a fresh RABI_AGENT_BOOTSTRAP_TICKET. Existing identities are preserved." : "RABI_AGENT_BOOTSTRAP_TICKET is required for bootstrap.");
  const defaultWorkspace = resolveRealDirectory(process.env.RABI_AGENT_DEFAULT_CWD || process.cwd(), "RABI_AGENT_DEFAULT_CWD");
  const allowedWorkspaces = normalizeAllowedWorkspaces(parseWorkspaceList(process.env.RABI_AGENT_ALLOWED_CWDS, defaultWorkspace), defaultWorkspace);

  const releasePublicKeySha256 = normalizedPublicKeySha256(process.env.RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256);
  const codexThreadId = String(process.env.RABI_AGENT_CODEX_THREAD_ID || "").trim();
  const agentType = process.env.RABI_AGENT_TYPE?.trim() || undefined;
  if (agentType && !["codex-desktop", "dsh"].includes(agentType)) throw new Error("Unsupported RABI_AGENT_TYPE.");
  if (agentType === "codex-desktop" && !codexThreadId) throw new Error("RABI_AGENT_CODEX_THREAD_ID is required for Codex Desktop.");
  const dsh = agentType === "dsh" ? normalizeDshBinding({ baseUrl: process.env.RABI_AGENT_DSH_URL, sessionId: process.env.RABI_AGENT_DSH_SESSION_ID }) : undefined;
  const config = {
    ...previous,
    schemaVersion: 1,
    agentType: agentType || previous?.agentType,
    dsh: dsh || previous?.dsh,
    managerUrl,
    autoUpdate: previous?.autoUpdate !== false,
    nodeId: previous?.nodeId || String(process.env.RABI_NODE_ID || "").trim() || randomNodeId(),
    releasePublicKeySha256,
    managerGuid: String(previous?.managerGuid || "").trim() || undefined,
    applicationGenerationId: String(previous?.applicationGenerationId || "").trim() || undefined,
    managerInstanceId: String(previous?.managerInstanceId || "").trim() || undefined,
    defaultWorkspace,
    allowedWorkspaces,
    codexDesktop: agentType === "codex-desktop" ? {
      threadId: codexThreadId,
      model: String(process.env.RABI_AGENT_CODEX_MODEL || "").trim() || undefined,
      reasoningEffort: String(process.env.RABI_AGENT_CODEX_REASONING || "medium").trim() || "medium"
    } : previous?.codexDesktop
  };
  // Reconnecting an installed computer must not erase its Agent identities or permitted projects.
  if (previous) {
    config.agents = instanceAgents(previous);
    config.allowedWorkspaces = normalizeAllowedWorkspaces([...(previous.allowedWorkspaces || []), ...allowedWorkspaces], defaultWorkspace);
  }
  // A computer can enroll without installing or opening an Agent backend.
  // Existing catalogs retain their identity; an explicit backend opts into binding.
  config.agents ??= agentType ? instanceAgents(config) : [];
  delete config.lanLinkToken;
  delete config.bootstrapTicket;
  let response;
  let body;
  try {
    response = await fetcher(`${managerUrl}/api/lan-agent/enroll`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket, nodeId: config.nodeId })
    });
    body = await response.json();
  } catch {
    throw new Error("Enrollment result is uncertain (transport, redirect or timeout); do not automatically retry. Verify the node in Manager before obtaining a new ticket.");
  }
  if (!response.ok || body?.code !== 0) throw new Error(`Enrollment ${response.status >= 500 || body?.uncertain ? "result is uncertain" : "failed"} (HTTP ${response.status}); no automatic retry. Verify the node in Manager before reconnecting.`);
  if (body.data?.nodeId !== config.nodeId || typeof body.data?.token !== "string" || !body.data.token.trim()) throw new Error("Enrollment returned an invalid node identity; result uncertain. Do not retry automatically.");
  config.nodeCredential = body.data.token;
  // Persist the successful exchange before the read-only identity check: a timeout
  // must not lose the only copy of a credential from a consumed ticket.
  writePrivateJson(configPath, config);
  await verifyNodeIdentity(config, fetcher);
  return config;
}

function currentReleasePath(configPath) {
  return path.join(path.dirname(configPath), "current-release.json");
}

function releaseDigest(release) { return sha256(Buffer.from(manifestPayload(release))); }
function readInstalledDigest(entrypoint) {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(entrypoint), "release-identity.json"), "utf8")).digest; } catch { return undefined; }
}
function writeCurrentRelease(configPath, entrypoint, digest = readInstalledDigest(entrypoint)) {
  writePrivateJson(currentReleasePath(configPath), { entrypoint: path.resolve(entrypoint), ...(digest ? { digest } : {}), updatedAt: new Date().toISOString() });
}

function initializeCurrentRelease(configPath, entrypoint) {
  const filename = currentReleasePath(configPath);
  if (!fs.existsSync(filename)) { writeCurrentRelease(configPath, entrypoint); return; }
  // Bootstrap from an obsolete entry must never roll back an installed release.
  // An existing broken pointer needs explicit repair, not silent reinstallation.
  const current = readJson(filename, null);
  try {
    if (typeof current?.entrypoint === "string" && path.isAbsolute(current.entrypoint) && fs.statSync(current.entrypoint).isFile()) return;
  } catch { /* Fail closed without replacing the existing pointer. */ }
  throw new Error("Current release pointer is invalid; repair it explicitly before bootstrap.");
}

function launcherPath(configPath) {
  return path.join(path.dirname(configPath), "rabi-agent-launcher.mjs");
}

// Serialized into the stable launcher: no imports from a replaceable release.
async function stableLauncher(defaultConfigPath, policy) {
  const args = process.argv.slice(2);
  const index = args.indexOf("--config");
  const requestedConfig = index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : defaultConfigPath;
  const configPath = fs.existsSync(requestedConfig) ? fs.realpathSync(requestedConfig) : requestedConfig;
  const forwarded = args.filter((value, i) => value !== "--bootstrap" && i !== index && (index < 0 || i !== index + 1));
  const currentPath = path.join(path.dirname(configPath), "current-release.json");
  const configHash = createHash("sha256").update(process.platform === "win32" ? configPath.toLowerCase() : configPath).digest("hex");
  const diagnosticPath = path.join(path.dirname(configPath), `launcher-control-${configHash}.json`);
  const currentEntry = () => {
    const pointer = JSON.parse(fs.readFileSync(currentPath, "utf8"));
    if (!pointer.entrypoint || !fs.statSync(pointer.entrypoint).isFile()) throw new Error("Current release is missing.");
    return path.resolve(pointer.entrypoint);
  };
  if (forwarded.includes("--api") || forwarded.includes("--upload")) {
    const child = spawn(process.execPath, [currentEntry(), ...forwarded, "--config", configPath], { stdio: "inherit", windowsHide: true });
    child.once("error", () => { process.exitCode = 1; });
    child.once("exit", code => { process.exitCode = code ?? 1; });
    return;
  }
  // The listening handle is the only lease. Retired launcher-owner.json,
  // .recovery and launcher-control.sock are neither consulted nor removed.
  // Unix pathname sockets cannot be safely recovered with probe-then-unlink;
  // use exactly one deterministic loopback port, never scan or steal a busy one.
  const controlTarget = process.platform === "win32" ? `\\\\.\\pipe\\rabi-agent-${configHash}`
    : { host: "127.0.0.1", port: 16384 + (Number.parseInt(configHash.slice(0, 8), 16) % 16384), exclusive: true };
  const { randomBytes, createHmac } = await import("node:crypto");
  const proof = (token, operation, nonce) => createHmac("sha256", token).update(`${configHash}:${operation}:${nonce}`).digest("hex");
  const commandIndex = forwarded.indexOf("--command");
  const requestedCommand = commandIndex >= 0 ? forwarded[commandIndex + 1] : undefined;
  if (commandIndex >= 0 && !requestedCommand) throw new Error("Launcher command is required.");
  if (requestedCommand && !["status", "start", "pause", "restart", "reconnect", "enable-startup", "disable-startup"].includes(requestedCommand)) throw new Error("Unsupported launcher command.");
  if (forwarded.includes("--stop") || requestedCommand) {
    let diagnostic;
    try { diagnostic = JSON.parse(fs.readFileSync(diagnosticPath, "utf8")); } catch { /* Absence is not a lease. */ }
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(controlTarget);
      const nonce = randomBytes(32).toString("hex");
      let buffer = ""; let authenticated = false; let complete = false;
      socket.setTimeout(12000, () => socket.destroy(new Error("Launcher stop timed out; result uncertain.")));
      socket.once("connect", () => {
        if (diagnostic?.configHash !== configHash || !/^[a-f0-9]{64}$/.test(diagnostic?.token || "")) {
          socket.destroy(new Error("Launcher stop identity is unavailable; no stop sent.")); return;
        }
        socket.write(`hello ${nonce}\n`);
      });
      socket.on("data", bytes => {
        buffer += bytes.toString();
        if (buffer.length > 512) { socket.destroy(new Error("Invalid launcher control response.")); return; }
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!authenticated && line === `owner ${proof(diagnostic.token, "owner", nonce)}`) {
            authenticated = true;
            socket.write(requestedCommand ? `command ${requestedCommand} ${proof(diagnostic.token, requestedCommand, nonce)}\n` : `stop ${proof(diagnostic.token, "stop", nonce)}\n`);
          } else if (authenticated && line === "stopped") { complete = true; socket.end(); }
          else if (authenticated && requestedCommand && line.startsWith("{")) {
            const receipt = JSON.parse(line);
            process.stdout.write(`${JSON.stringify(receipt)}\n`);
            if (!receipt.ok) process.exitCode = 1;
            complete = true; socket.end();
          }
          else { socket.destroy(new Error("Launcher control identity mismatch; no unauthenticated stop sent.")); return; }
        }
      });
      socket.once("error", error => {
        if (!requestedCommand && !authenticated && ["ENOENT", "ECONNREFUSED"].includes(error.code)) { complete = true; resolve(); }
        else reject(error);
      });
      socket.once("close", () => complete ? resolve() : reject(new Error("Launcher stop was not acknowledged; result uncertain.")));
    });
    return;
  }
  const token = randomBytes(32).toString("hex");
  const children = new Set(); const sockets = new Set(); const stopWaiters = new Set();
  let worker; let candidate; let stopping = false; let released = false; let retryTimer; let stopDeadline; let failures = 0; let workerStartedAt;
  let presentation; let paused = false; let transitioning = false; let presentationClosing = false; let presentationClosed = false;
  let publicState = { summary: "正在启动连接器", version: "", agents: "", task: "", managerOrigin: "", busy: false };
  const recentEvents = [];
  const startupPlan = () => startupFiles("win32", process.execPath, launcherPath(configPath), configPath, { home: process.env.USERPROFILE, env: process.env });
  const startupEnabled = () => process.platform === "win32" && fs.existsSync(startupPlan().files[0].path);
  const publish = (summary) => {
    if (summary) {
      publicState.summary = summary;
      recentEvents.push(`${new Date().toLocaleTimeString()}  ${summary}`);
      if (recentEvents.length > 120) recentEvents.shift();
    }
    presentation?.publish();
  };
  const publicSnapshot = () => ({
    summary: publicState.summary, running: Boolean(worker), busy: transitioning || Boolean(candidate) || publicState.busy,
    startup: startupEnabled(), canOpenManager: Boolean(publicState.managerOrigin),
    details: [`状态：${publicState.summary}`, `主程序 PID：${process.pid}`, `连接器 PID：${worker?.pid || "—"}`,
      `版本：${publicState.version || "待确认"}`, `主机：${publicState.managerOrigin || "待连接"}`,
      `Agent：${publicState.agents || "待确认"}`, `任务：${publicState.task || "暂无"}`, "", "最近状态记录（最多 120 条）：", ...recentEvents].join("\n")
  });
  const send = (child, message) => { if (child?.connected) child.send(message, () => undefined); };
  const control = net.createServer(socket => {
    sockets.add(socket);
    socket.setTimeout(10000, () => socket.destroy());
    let buffer = ""; let nonce;
    socket.on("data", bytes => {
      buffer += bytes.toString();
      if (buffer.length > 512) { socket.destroy(); return; }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!nonce && /^hello [a-f0-9]{64}$/.test(line)) {
          nonce = line.slice(6); socket.write(`owner ${proof(token, "owner", nonce)}\n`);
        } else if (nonce && line === `stop ${proof(token, "stop", nonce)}`) {
          if (released) socket.end("stopped\n");
          else { stopWaiters.add(socket); stop(); }
          return;
        } else if (nonce && /^command (status|start|pause|restart|reconnect|enable-startup|disable-startup) [a-f0-9]{64}$/.test(line)) {
          const [, action, signature] = line.split(" ");
          if (signature !== proof(token, action, nonce)) { socket.destroy(); return; }
          nonce = undefined;
          const operation = action === "status" ? Promise.resolve()
            : action.endsWith("-startup") ? desktopCommand("startup", action === "enable-startup") : desktopCommand(action);
          void operation.then(() => {
            socket.end(`${JSON.stringify({ ok: true, ...publicSnapshot(), pid: process.pid, workerPid: worker?.pid, trayPid: presentation?.pid })}\n`);
          }).catch(() => socket.end(`${JSON.stringify({ ok: false, error: "Operation refused or failed; existing owner retained." })}\n`));
          return;
        } else { socket.destroy(); return; }
      }
    });
    socket.once("close", () => { sockets.delete(socket); stopWaiters.delete(socket); });
    socket.on("error", () => undefined);
  });
  const finishStop = () => {
    if (released || children.size || !control.listening) return;
    if (presentation && !presentationClosed) {
      if (!presentationClosing) {
        presentationClosing = true;
        void presentation.close().then(() => { presentationClosed = true; finishStop(); });
      }
      return;
    }
    released = true; clearTimeout(stopDeadline);
    // Keep the lease until all owned workers/candidates have actually closed.
    control.close();
    for (const socket of sockets) {
      if (stopWaiters.has(socket)) socket.end("stopped\n");
      // Already connected clients may still be authenticating. Let their short
      // protocol finish rather than resetting a concurrent repeated stop.
    }
    // Keep the diagnostic bytes: stale diagnostics never obstruct acquisition,
    // and a late exit must not unlink a subsequent owner's authentication data.
  };
  const stop = () => {
    if (stopping) return;
    stopping = true; clearTimeout(retryTimer);
    for (const child of children) child.kill("SIGTERM");
    stopDeadline = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 5000);
    stopDeadline.unref();
    if (!children.size) finishStop();
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const recover = () => {
    if (stopping || paused || transitioning) return;
    if (Date.now() - workerStartedAt >= policy.stableMs) failures = 0;
    if (failures >= policy.maxRestarts) {
      process.stderr.write("Rabi Agent launcher restart budget exhausted.\n"); process.exitCode = 1;
      if (presentation?.pid) { paused = true; publish("连接器异常退出；请点击启动重试"); } else stop();
      return;
    }
    const wait = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** failures++);
    process.stderr.write(`Rabi Agent launcher recovering after abnormal exit in ${wait} ms.\n`);
    publish("连接器异常退出，正在恢复");
    retryTimer = setTimeout(startWorker, wait);
  };
  const startChild = (entrypoint, isCandidate = false) => {
    const child = spawn(process.execPath, [entrypoint, ...(isCandidate ? ["--run"] : forwarded.length ? forwarded : ["--run"]), "--config", configPath], {
      cwd: path.dirname(entrypoint), windowsHide: true, stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: { ...process.env, RABI_AGENT_SUPERVISED: "1", RABI_AGENT_UPDATE_CANDIDATE: isCandidate ? "1" : "0" }
    });
    children.add(child);
    child.on("message", message => {
      if (child === candidate?.child) { send(candidate.owner, { type: "launcherCandidateEvent", requestId: candidate.requestId, event: message }); return; }
      if (child !== worker || stopping) return;
      if (message?.type === "desktopSnapshot") {
        for (const key of ["summary", "version", "agents", "task"]) if (typeof message[key] === "string") publicState[key] = message[key].slice(0, 2048);
        publicState.busy = message.busy === true;
        try {
          const origin = new URL(message.managerOrigin);
          if (["http:", "https:"].includes(origin.protocol) && !origin.username && !origin.password) publicState.managerOrigin = origin.origin;
        } catch { publicState.managerOrigin = ""; }
        publish(publicState.summary);
      } else if (message?.type === "launcherSpawnCandidate" && !candidate) {
        candidate = { owner: child, requestId: message.requestId, child: null };
        candidate.child = startChild(path.resolve(message.entrypoint), true);
      } else if (message?.requestId === candidate?.requestId && candidate.owner === child) {
        if (message.type === "launcherCandidateCommand") send(candidate.child, { type: message.command });
        if (message.type === "launcherTerminateCandidate") candidate.child.kill("SIGKILL");
        if (message.type === "launcherReleaseCandidate") {
          // The existing committed candidate becomes the supervised worker. Do
          // not spawn from a changed pointer when the retired worker exits 0.
          worker = candidate.child; workerStartedAt = Date.now(); candidate = null;
          send(worker, { type: "launcherCommitted" });
        }
      }
    });
    child.once("error", error => { process.stderr.write(`Rabi Agent child spawn failed: ${error.code || "unknown"}.\n`); });
    child.once("close", (code, signal) => {
      children.delete(child);
      if (child === candidate?.child) {
        send(candidate.owner, { type: "launcherCandidateExit", requestId: candidate.requestId, code, signal }); candidate = null;
      }
      if (stopping) { if (!children.size) finishStop(); return; }
      if (child !== worker) return;
      worker = null;
      publicState.busy = false;
      if (paused || transitioning) { publish("连接器已停止"); return; }
      if (candidate) {
        const pending = candidate.child;
        candidate = null;
        pending.once("close", () => { if (code === 0 && !signal) stop(); else recover(); });
        pending.kill("SIGKILL");
        return; // Confirm the uncommitted child exited before any recovery.
      }
      if (code === 0 && !signal) { stop(); return; }
      recover();
    });
    return child;
  };
  function startWorker() {
    if (stopping || paused) return;
    publish("正在启动连接器");
    workerStartedAt = Date.now();
    try { worker = startChild(currentEntry()); }
    catch { process.stderr.write("Rabi Agent launcher could not read current release.\n"); recover(); }
  }
  const haltWorker = async () => {
    clearTimeout(retryTimer);
    const owned = worker;
    if (!owned) return;
    await new Promise(resolve => {
      const deadline = setTimeout(() => owned.kill("SIGKILL"), 5000);
      owned.once("close", () => { clearTimeout(deadline); resolve(); });
      owned.kill("SIGTERM");
    });
  };
  const desktopCommand = async (action, enabled) => {
    if (stopping) return;
    if (action === "exit") { stop(); return; }
    if (action === "open-manager") {
      if (!publicState.managerOrigin) return;
      // Credential-free navigation; the browser uses its own login flow.
      const child = spawn("explorer.exe", [`${publicState.managerOrigin}/#/rabilink?tab=agents`], { windowsHide: true, stdio: "ignore" });
      child.on("error", () => publish("无法打开主机管理页"));
      return;
    }
    if (action === "startup") {
      if (typeof enabled !== "boolean" || process.platform !== "win32") return;
      const entry = startupPlan().files[0];
      const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(entry.content, "utf16le")]);
      const existing = fs.existsSync(entry.path) ? fs.readFileSync(entry.path) : null;
      if (existing && !existing.equals(bytes)) throw new Error("Startup belongs to another installation; unchanged.");
      if (existing) fs.writeFileSync(path.join(path.dirname(configPath), "startup-before-change.vbs"), existing, { mode: 0o600 });
      if (enabled) {
        fs.mkdirSync(path.dirname(entry.path), { recursive: true });
        const temporary = `${entry.path}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, entry.path);
        if (!fs.readFileSync(entry.path).equals(bytes)) throw new Error("Startup readback failed.");
      } else if (existing) fs.unlinkSync(entry.path);
      recentEvents.push(`${new Date().toLocaleTimeString()}  ${enabled ? "已开启开机启动" : "已关闭开机启动"}`);
      if (recentEvents.length > 120) recentEvents.shift();
      publish();
      return;
    }
    if (transitioning || candidate || publicState.busy) throw new Error("Connector is busy.");
    if (action === "reconnect") { send(worker, { type: "desktopReconnect" }); return; }
    if (action === "start") {
      if (worker) return;
      paused = false; failures = 0; startWorker(); return;
    }
    if (["pause", "restart"].includes(action)) {
      transitioning = true; paused = true; publish("正在停止连接器");
      try {
        await haltWorker();
        if (action === "restart" && !stopping) { paused = false; failures = 0; startWorker(); }
      } finally { transitioning = false; publish(); }
    }
  };
  try {
    await new Promise((resolve, reject) => {
      const failed = error => { control.removeListener("listening", ready); reject(error); };
      const ready = () => { control.removeListener("error", failed); resolve(); };
      control.once("error", failed); control.once("listening", ready); control.listen(controlTarget);
    });
  } catch (error) {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    if (error.code === "EADDRINUSE") throw new Error("Rabi Agent launcher ownership is busy; no worker started.");
    throw error;
  }
  control.on("error", () => { process.exitCode = 1; stop(); });
  if (stopping) { finishStop(); return; }
  // This is authentication/diagnostic data, never an acquisition predicate.
  // Publish only after listen; failure releases the kernel lease without spawning.
  try {
    const temporary = `${diagnosticPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ pid: process.pid, configHash, token })}\n`, { mode: 0o600 });
    fs.renameSync(temporary, diagnosticPath);
    fs.chmodSync(diagnosticPath, 0o600);
  } catch (error) { stop(); throw error; }
  presentation = createDesktopPresentation({ currentEntry, snapshot: publicSnapshot, command: desktopCommand,
    enabled: process.platform === "win32" && policy.desktop !== false,
    onFailure: (summary, fatal) => { publish(summary); if (fatal) { process.exitCode = 1; stop(); } }
  });
  startWorker();
}

function writeLauncher(configPath, policy = { baseDelayMs: 1000, maxDelayMs: 30000, maxRestarts: 5, stableMs: 60000 }) {
  const writeObservedText = (filename, content) => {
    if (fs.existsSync(filename)) fs.readFileSync(filename);
    const temporary = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filename);
  };
  const hookShim = `import fs from "node:fs";\nimport path from "node:path";\nimport { pathToFileURL } from "node:url";\nexport async function requestInstanceHook(input, configPath, fetcher = fetch) {\n const current = JSON.parse(fs.readFileSync(path.join(path.dirname(path.resolve(configPath)), "current-release.json"), "utf8"));\n const module = await import(pathToFileURL(path.join(path.dirname(current.entrypoint), "lib", "instance-hook.mjs")).href);\n return module.requestInstanceHook(input, configPath, fetcher);\n}\n`;
  writeObservedText(path.join(path.dirname(configPath), "hook-client.mjs"), hookShim);
  const launcher = launcherPath(configPath);
  const code = `import fs from "node:fs";\nimport path from "node:path";\nimport net from "node:net";\nimport { createHash } from "node:crypto";\nimport { spawn } from "node:child_process";\nconst createDesktopPresentation = ${createDesktopPresentation.toString()};\nconst startupCommand = ${startupCommand.toString()};\nconst startupFiles = ${startupFiles.toString()};\nconst launcherPath = ${launcherPath.toString()};\n(${stableLauncher.toString()})(${JSON.stringify(path.resolve(configPath))}, ${JSON.stringify(policy)}).catch(error => { process.stderr.write(error.message + "\\n"); process.exitCode = 1; });\n`;
  writeObservedText(launcher, code);
  return launcher;
}

function startupCommand(platform, executable, script, config) {
  const args = [executable, script, "--config", config];
  if (platform === "win32") {
    const quote = value => {
      if (/["\r\n\0]/.test(value)) throw new Error("Invalid Windows startup argument.");
      return `"${value.replace(/%/g, "%%")}"`;
    };
    return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${args.map(quote).join(" ")}\r\n`;
  }
  if (platform === "darwin") {
    const xml = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.rabiroute.agent</string><key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer></dict></plist>\n`;
  }
  // Exec quoting is not shell quoting. Escape reserved characters, then the
  // desktop-entry string layer; literal percent signs are not field codes.
  const quote = value => `"${value.replace(/([\\"`$])/g, "\\$1").replace(/\\/g, "\\\\").replace(/%/g, "%%").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
  return `[Desktop Entry]\nType=Application\nName=Rabi Agent\nExec=${args.map(quote).join(" ")}\nX-GNOME-Autostart-enabled=true\n`;
}

function startupFiles(platform, executable, script, config, { home, env = {}, uid } = {}) {
  const files = [];
  const add = (filename, content) => { files.push({ path: filename, content }); return filename; };
  if (platform === "win32") {
    startupCommand(platform, executable, script, config); // Validate Windows argv before rendering VBS.
    const startup = path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    // Run expands environment variables once. Restore literal % via a dedicated
    // process variable; launch Node directly, without a second cmd expansion.
    const vbsLiteral = value => `"${value.replace(/"/g, '""')}"`;
    const command = [executable, script, "--config", config].map(value => `"${value.replace(/%/g, "%RABI_LITERAL_PERCENT%")}"`).join(" ");
    add(path.join(startup, "RabiAgent.vbs"), `Option Explicit\r\nDim shell\r\nSet shell = CreateObject("WScript.Shell")\r\nshell.Environment("PROCESS")("RABI_LITERAL_PERCENT") = Chr(37)\r\nshell.Run ${vbsLiteral(command)}, 0, False\r\n`);
    files[files.length - 1].encoding = "utf16le"; // WSH reads Unicode only with a UTF-16 BOM.
    return { files, obsolete: [path.join(startup, "RabiAgent.cmd")], mode: "windows-login-hidden", activation: [] };
  }
  if (platform === "darwin") {
    if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("A current user uid is required for launchd.");
    const plist = add(path.join(home, "Library", "LaunchAgents", "com.rabiroute.agent.plist"), startupCommand(platform, executable, script, config));
    return { files, obsolete: [], mode: "user-launchd", activation: [["launchctl", ["print", `gui/${uid}/com.rabiroute.agent`]], ["launchctl", ["bootstrap", `gui/${uid}`, plist]]] };
  }
  const directory = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const quote = value => {
    if (/[\r\n\0]/.test(value)) throw new Error("Invalid systemd startup argument.");
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$")}"`;
  };
  add(path.join(directory, "systemd", "user", "rabi-agent.service"), `[Unit]\nDescription=Rabi Agent current-user connector\nStartLimitIntervalSec=300\nStartLimitBurst=5\n[Service]\nType=simple\nExecStart=${[executable, script, "--config", config].map(quote).join(" ")}\nRestart=on-failure\nRestartSec=30\nKillMode=control-group\nTimeoutStopSec=10\n[Install]\nWantedBy=default.target\n`);
  return { files, obsolete: [], mode: "user-systemd", activation: [["systemctl", ["--user", "show-environment"]], ["systemctl", ["--user", "daemon-reload"]], ["systemctl", ["--user", "enable", "--now", "rabi-agent.service"]]],
    fallback: { path: path.join(directory, "autostart", "rabi-agent.desktop"), content: startupCommand("linux", executable, script, config) } };
}

function runStartupCommand(executable, args) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, diagnostic: "command timed out" }); }, 10000);
    child.once("error", error => { clearTimeout(timer); resolve({ ok: false, diagnostic: error.code }); });
    child.once("exit", code => { clearTimeout(timer); resolve({ ok: code === 0, diagnostic: `exit ${code}` }); });
  });
}

async function configureCurrentUserStartup(_entrypoint, configPath, options = {}) {
  const platform = options.platform || process.platform;
  const script = path.resolve(writeLauncher(configPath));
  const plan = startupFiles(platform, options.executable || process.execPath, script, path.resolve(configPath), {
    home: options.home || os.homedir(), env: options.env || process.env, uid: options.uid ?? process.getuid?.()
  });
  const write = file => {
    if (fs.existsSync(file.path)) fs.readFileSync(file.path); // Observe before replacement.
    fs.mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file.path, file.encoding === "utf16le" ? `\uFEFF${file.content}` : file.content, { encoding: file.encoding || "utf8", mode: 0o600 });
  };
  plan.files.forEach(write);
  for (const obsolete of plan.obsolete) if (fs.existsSync(obsolete)) { fs.readFileSync(obsolete); fs.unlinkSync(obsolete); }
  if (!options.activate) return { mode: plan.mode, activated: false, diagnostic: "Startup configured; current-user service activation not requested." };
  const run = options.runCommand || runStartupCommand;
  if (platform === "darwin") {
    const loaded = await run(...plan.activation[0]);
    const result = loaded.ok ? loaded : await run(...plan.activation[1]);
    return { mode: plan.mode, activated: result.ok, diagnostic: result.ok ? undefined : `User launchd not loaded: ${result.diagnostic}` };
  }
  if (platform === "linux") {
    for (const command of plan.activation) {
      const result = await run(...command);
      if (!result.ok) {
        write(plan.fallback);
        return { mode: "desktop-login-fallback", activated: false, diagnostic: `User systemd unavailable or activation failed (${result.diagnostic}); desktop-login fallback uses stable launcher only, without systemd service supervision. No linger or prelogin authorization requested.` };
      }
    }
    if (fs.existsSync(plan.fallback.path)) { fs.readFileSync(plan.fallback.path); fs.unlinkSync(plan.fallback.path); }
  }
  return { mode: plan.mode, activated: true };
}
function readConfig(configPath) {
  const config = readJson(configPath, null);
  if (!config || config.schemaVersion !== 1) throw new Error(`Rabi Agent configuration is missing or invalid: ${configPath}`);
  const managerUrl = normalizeManagerUrl(config.managerUrl);
  const nodeCredential = String(config.nodeCredential || "").trim();
  if (!nodeCredential && config.lanLinkToken) throw new Error("Legacy lanLinkToken is not accepted; re-enroll using RABI_AGENT_BOOTSTRAP_TICKET. Existing nodeId, agents and workspaces are preserved.");
  const nodeId = String(config.nodeId || "").trim();
  const releasePublicKeySha256 = normalizedPublicKeySha256(config.releasePublicKeySha256, "Rabi Agent release public key fingerprint");
  const defaultWorkspace = resolveRealDirectory(config.defaultWorkspace, "Rabi Agent default workspace");
  const allowedWorkspaces = normalizeAllowedWorkspaces(config.allowedWorkspaces, defaultWorkspace);
  const codexThreadId = String(config.codexDesktop?.threadId || "").trim();
  const agentType = config.agentType || "codex-desktop";
  const hasAgentCatalog = Array.isArray(config.agents);
  if (!["codex-desktop", "dsh"].includes(agentType)) throw new Error("Unsupported Rabi Agent type.");
  if (!nodeCredential || !nodeId || (!hasAgentCatalog && agentType === "codex-desktop" && !codexThreadId)) throw new Error(`Rabi Agent configuration is incomplete: ${configPath}`);
  return {
    agentType,
    dsh: agentType === "dsh" && (!hasAgentCatalog || config.dsh) ? normalizeDshBinding(config.dsh) : undefined,
    schemaVersion: 1,
    agents: config.agents,
    managerUrl,
    nodeCredential,
    nodeId,
    releasePublicKeySha256,
    autoUpdate: config.autoUpdate !== false,
    managerGuid: String(config.managerGuid || "").trim() || undefined,
    applicationGenerationId: String(config.applicationGenerationId || "").trim() || undefined,
    managerInstanceId: String(config.managerInstanceId || "").trim() || undefined,
    defaultWorkspace,
    allowedWorkspaces,
    codexDesktop: {
      threadId: codexThreadId,
      model: String(config.codexDesktop?.model || "").trim() || undefined,
      reasoningEffort: String(config.codexDesktop?.reasoningEffort || "medium").trim() || "medium"
    }
  };
}

function createAgentState(configPath) {
  const statePath = path.join(path.dirname(configPath), "state.json");
  const state = readJson(statePath, { schemaVersion: 1, tasks: {} });
  if (state.schemaVersion !== 1 || !state.tasks || typeof state.tasks !== "object") return { statePath, state: { schemaVersion: 1, tasks: {} } };
  return { statePath, state };
}

function rememberTask(store, taskId, value) {
  delete store.state.tasks[taskId];
  store.state.tasks[taskId] = { ...value, updatedAt: new Date().toISOString() };
  const keys = Object.keys(store.state.tasks);
  while (keys.length > TASK_HISTORY_LIMIT) delete store.state.tasks[keys.shift()];
  writePrivateJson(store.statePath, store.state);
}

function releaseDirectory(configPath, version) {
  return path.join(path.dirname(configPath), "releases", version);
}

async function authorizedFetch(config, pathname, fetcher = fetch) {
  const session = config.managerGuid ? createEndpointSession({ config, fetchImpl: fetcher }) : null;
  let origin = normalizeManagerUrl(config.managerUrl);
  try { const endpoint = await session.ensure({ diagnostic: true }); origin = endpoint.managerUrl; Object.assign(config, endpoint.config); } catch (error) { if (config.managerGuid) throw error; }
  const target = new URL(pathname, `${origin}/`);
  if (!pathname.startsWith("/") || pathname.startsWith("//") || /[\\\r\n#]/.test(pathname) || target.origin !== origin || target.username || target.password) throw new Error("Cross-origin Manager request rejected.");
  if (!config.nodeCredential) throw new Error("An independent nodeCredential is required; re-enroll this connector.");
  const url = target.toString();
  const response = await fetcher(url, { headers: { authorization: `Bearer ${config.nodeCredential}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Rabi Manager returned HTTP ${response.status} for ${new URL(url).pathname}.`);
  return response;
}

async function fetchReleaseManifest(config) {
  const response = await authorizedFetch(config, "/api/lan-agent/releases/manifest");
  const body = await response.json();
  const release = body?.release;
  if (!release || !verifyReleaseManifest(release, config.releasePublicKeySha256)) {
    throw new Error("Rabi Agent release public key fingerprint or manifest signature verification failed.");
  }
  if (release.platform !== "node") throw new Error(`Rabi Agent release platform is not supported: ${release.platform}`);
  if (!versionAtLeast(process.versions.node, release.minNodeVersion)) throw new Error(`Rabi Agent requires Node.js ${release.minNodeVersion} or newer.`);
  return release;
}

async function installRelease(config, release, configPath = CONFIG_PATH) {
  const digest = releaseDigest(release);
  const target = releaseDirectory(configPath, `${release.version}-${digest}`);
  const entrypoint = path.join(target, "rabi-agent.mjs");
  if (fs.existsSync(target)) {
    for (const file of release.files) {
      const filename = path.join(target, safeRelativePath(file.path));
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== file.size || sha256(fs.readFileSync(filename)) !== file.sha256) throw new Error("Installed release integrity check failed.");
    }
    if (readInstalledDigest(entrypoint) !== digest) throw new Error("Installed release identity mismatch.");
    return entrypoint;
  }
  const temporary = `${target}.installing-${process.pid}-${Date.now()}`;
  fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
  try {
    for (const file of release.files) {
      const relative = safeRelativePath(file.path);
      const downloadUrl = String(file.downloadUrl || "");
      if (!downloadUrl.startsWith("/api/lan-agent/releases/")) throw new Error(`Rabi Agent release has an invalid download URL: ${downloadUrl}`);
      const response = await authorizedFetch(config, downloadUrl);
      const content = Buffer.from(await response.arrayBuffer());
      if (content.byteLength !== file.size || sha256(content) !== file.sha256) throw new Error(`Rabi Agent release file verification failed: ${relative}`);
      const destination = path.resolve(temporary, ...relative.split("/"));
      if (!destination.startsWith(`${temporary}${path.sep}`)) throw new Error(`Rabi Agent release path escapes installation directory: ${relative}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, content, { mode: 0o600 });
    }
    if (!fs.existsSync(path.join(temporary, "rabi-agent.mjs"))) throw new Error("Rabi Agent release is missing rabi-agent.mjs.");
    writePrivateJson(path.join(temporary, "release-identity.json"), { digest, version: release.version });
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(target)) fs.renameSync(temporary, target);
    return entrypoint;
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function spawnUpdateCandidate(entrypoint, configPath) {
  const supervised = process.env.RABI_AGENT_SUPERVISED === "1" && process.connected;
  const requestId = `${process.pid}-${Date.now()}`;
  const child = supervised ? new EventEmitter() : spawn(process.execPath, [entrypoint, "--run", "--config", configPath], {
    cwd: path.dirname(entrypoint), env: { ...process.env, RABI_AGENT_UPDATE_CANDIDATE: "1" },
    detached: false, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true
  });
  let relay;
  if (supervised) {
    child.connected = true; child.exitCode = null; child.signalCode = null; child.pid = 1;
    child.send = (message, callback) => process.send({ type: "launcherCandidateCommand", requestId, command: message.type }, callback);
    child.kill = () => process.send({ type: "launcherTerminateCandidate", requestId });
    relay = message => {
      if (message?.requestId !== requestId) return;
      if (message.type === "launcherCandidateEvent") child.emit("message", message.event);
      if (message.type === "launcherCandidateExit") { child.exitCode = message.code; child.signalCode = message.signal; child.emit("exit"); }
    };
    process.on("message", relay);
    process.send({ type: "launcherSpawnCandidate", requestId, entrypoint });
  }
  const messages = new Map();
  let failure;
  let exited = false;
  child.on("message", message => { if (message?.type) messages.set(message.type, message); });
  child.on("error", error => { failure = error; });
  child.on("exit", () => { exited = true; });
  return {
    async wait(type) {
      const deadline = Date.now() + 30_000;
      while (!failure && !exited && Date.now() < deadline) {
        if (messages.has(type)) return messages.get(type);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error("Rabi Agent candidate did not connect or acknowledge within 30 seconds; the current version remains active.");
    },
    send(type) {
      return new Promise((resolve, reject) => child.send({ type }, error => error ? reject(error) : resolve()));
    },
    async terminate() {
      if (exited || child.exitCode !== null || child.signalCode !== null || !child.pid) {
        if (relay) process.removeListener("message", relay);
        return;
      }
      // This is our uncommitted child, not an external Agent/Host owner.
      // SIGTERM handlers may retain IPC, so force its exit before rollback.
      child.kill("SIGKILL");
      const deadline = Date.now() + 5000;
      while (!exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      if (!exited) throw new Error("Candidate exit could not be confirmed; old connection remains paused to avoid duplicate node ownership.");
      if (relay) process.removeListener("message", relay);
    },
    async release() {
      if (supervised) {
        if (relay) {
          process.removeListener("message", relay); relay = null;
          await new Promise((resolve, reject) => process.send({ type: "launcherReleaseCandidate", requestId }, error => error ? reject(error) : resolve()));
        }
        return;
      }
      if (child.connected) child.disconnect();
      child.unref(); // The committed worker no longer keeps the retired parent alive.
    }
  };
}

class RabiAgentRuntime {
  constructor(config, configPath) {
    this.config = config;
    this.endpointSession = createEndpointSession({ config, configPath });
    this.configPath = configPath;
    this.stateStore = createAgentState(configPath);
    this.socket = null;
    this.connected = false;
    this.heartbeatTimer = null;
    this.retryTimer = null;
    this.retryMs = RECONNECT_BASE_MS;
    this.stopped = false;
    this.connectionPaused = false;
    this.draining = false;
    this.updatePromise = null;
    this.candidatePending = UPDATE_CANDIDATE;
    this.taskQueue = Promise.resolve();
    this.pendingOperations = 0;
    this.taskByThread = new Map();
    this.desktopSummary = "正在连接主机";
    this.lastDesktopTask = "";
    this.agentExecutionStatus = new Map();
    this.computer = new ComputerService({ onChange: () => this.publishDesktop() });
    this.terminals = new TerminalService({ defaultCwd: config.defaultWorkspace,
      emit: event => {
        if ((this.socket?.bufferedAmount || 0) > 1048576) {
          void this.terminals.execute({ action: "close", terminalId: event.terminalId }).catch(() => undefined);
          return;
        }
        this.send({ type: "terminalEvent", event });
      }, onChange: () => this.publishDesktop() });
    this.desktop = new CodexDesktopIpcClient({ onBroadcast: event => this.handleDesktopBroadcast(event) });
  }

  start() {
    this.connect();
  }

  publishDesktop(summary = this.desktopSummary) {
    this.desktopSummary = summary;
    let managerOrigin = "";
    try { managerOrigin = new URL(this.config.managerUrl).origin; } catch { }
    const payload = {
      type: "desktopSnapshot", summary, version: AGENT_VERSION, managerOrigin,
      agents: instanceAgents(this.config).map(agent => `${agent.provider}: ${agent.sessionId || "未绑定"} · ${this.agentExecutionStatus.get(agent.agentId) || "运行未核验"}`).join("\n") || "未关联智能体 · 电脑接口可用",
      task: `${this.lastDesktopTask}${this.terminals.activeCount ? ` · ${this.terminals.activeCount} 个终端` : ""}`,
      busy: this.draining || Boolean(this.updatePromise) || this.pendingOperations > 0 || this.taskByThread.size > 0 || this.terminals.activeCount > 0 || this.computer.activeCount > 0
    };
    if (process.connected) process.send?.(payload, () => undefined);
    return payload;
  }

  reconnect() {
    if (this.stopped || this.draining || this.updatePromise) return;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    clearInterval(this.heartbeatTimer);
    const oldSocket = this.socket;
    this.socket = null; this.connected = false;
    oldSocket?.close(1000, "User requested reconnect");
    void this.terminals.closeAll();
    this.retryMs = RECONNECT_BASE_MS;
    this.publishDesktop("正在重新连接主机");
    if (this.connecting) this.scheduleReconnect(); else this.connect();
  }

  queueOperation(operation) {
    this.pendingOperations++;
    this.publishDesktop();
    this.taskQueue = this.taskQueue.catch(() => undefined).then(operation).finally(() => {
      this.pendingOperations--;
      this.publishDesktop();
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.publishDesktop("连接器已停止");
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeatTimer);
    this.socket?.close(1000, "Rabi Agent stopping");
    this.desktop.close();
    void this.terminals.stop();
    this.computer.stop();
  }

  async connect() {
    if (this.stopped || this.connectionPaused || this.connecting || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.connecting = true;
    this.publishDesktop("正在连接主机");
    let socket;
    try {
      await verifyNodeIdentity(this.config, fetch, fs.existsSync(this.configPath) ? this.configPath : undefined);
      if (this.stopped || this.connectionPaused) return;
      socket = new WebSocket(managerWebSocketUrl(this.config.managerUrl));
    } catch (error) {
      // EndpointSession already performs bounded stable-GUID rediscovery and
      // persists only verified identities. Never resurrect the old preverify write.
      this.scheduleReconnect(error);
      return;
    } finally { this.connecting = false; }
    this.socket = socket;
    socket.addEventListener("open", () => this.send({ type: "authenticate", token: this.config.nodeCredential }));
    socket.addEventListener("message", event => { if (this.socket === socket) this.handleManagerMessage(event.data); });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.connected = false;
      void this.terminals.closeAll();
      clearInterval(this.heartbeatTimer);
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => undefined);
  }

  scheduleReconnect(error) {
    if (this.stopped || this.connectionPaused || this.retryTimer) return;
    this.publishDesktop(error ? "主机连接失败，等待重连" : "主机连接已断开，等待重连");
    const delay = this.retryMs;
    this.retryMs = Math.min(RECONNECT_MAX_MS, this.retryMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    // The reconnect timer owns offline liveness; only explicit stop may release it.
  }

  send(payload) {
    if (payload.taskId && ["ackTask", "progress", "taskResult"].includes(payload.type)) {
      const labels = { ackTask: "已接收", progress: "已投递", taskResult: payload.status === "completed" ? "已完成" : "失败" };
      this.lastDesktopTask = `${String(payload.taskId).slice(0, 160)} · ${labels[payload.type]}`;
      this.publishDesktop();
    }
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  handleManagerMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (!message || typeof message !== "object") return;
    if (message.type === "manageAgent" && ["terminal", "computer"].includes(message.operation)) {
      if (!this.connected || this.stopped) return;
      const socket = this.socket;
      const params = message.params || {};
      const createsResource = ["open", "upload.begin", "windows.list", "screen.capture", "file.read", "file.stat"].includes(params.action);
      const operation = (this.draining || this.candidatePending) && createsResource
        ? Promise.reject(new Error("Connector update is in progress; no new computer operation was started."))
        : (message.operation === "terminal" ? this.terminals : this.computer).execute(params);
      void operation.then(result => {
        if (this.socket === socket && this.connected) this.send({ type: "managementResult", requestId: message.requestId, result });
      }).catch(error => {
        if (this.socket === socket && this.connected) this.send({ type: "managementResult", requestId: message.requestId, error: boundedText(error.message, 512) });
      });
      return;
    }
    if (message.type === "authenticated") {
      this.send({
        type: "hello",
        node: {
          nodeId: this.config.nodeId,
          version: AGENT_VERSION,
          platform: `${process.platform}-${process.arch}`,
          agentTypes: [...new Set(instanceAgents(this.config).map(agent => agent.provider))],
          agents: agentCatalog(this.config),
          terminalShells: process.platform === "win32" ? ["cmd", "powershell"] : [],
          computerCapabilities: ["files", ...(process.platform === "win32" ? ["windows", "screenshots"] : [])],
          allowedWorkspaces: this.config.allowedWorkspaces
        }
      });
      return;
    }
    if (message.type === "connected") {
      this.connected = true;
      this.publishDesktop("已连接主机");
      this.retryMs = RECONNECT_BASE_MS;
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => this.send({ type: "heartbeat" }), HEARTBEAT_MS);
      this.heartbeatTimer.unref?.();
      if (this.candidatePending) process.send?.({ type: "candidateConnected", nodeId: this.config.nodeId });
      else if (this.config.autoUpdate !== false && typeof message.release?.releaseDigest === "string"
        && /^[a-f0-9]{64}$/.test(message.release.releaseDigest)
        && readInstalledDigest(fileURLToPath(import.meta.url)) !== message.release.releaseDigest) {
        void this.update(message.release.version).catch(error => {
          this.send({ type: "updateResult", status: "failed", error: boundedText(error instanceof Error ? error.message : String(error)) });
        });
      }
      return;
    }
    // Keep the owner connection alive for queued work/results while draining,
    // but do not accept new execution or mutate bindings during handoff.
    if ((this.draining || this.candidatePending) && ["assignTask", "manageAgent"].includes(message.type)) {
      if (message.type === "manageAgent") this.send({ type: "managementResult", requestId: message.requestId, error: "Rabi Agent update handoff is in progress; operation was not accepted." });
      else this.send({ type: "taskResult", taskId: message.task?.taskId, status: "failed", error: "Rabi Agent update handoff is in progress; task was not accepted." });
      return;
    }
    if (message.type === "assignTask" && message.task) {
      this.enqueueTask(message.task);
      return;
    }
    if (message.type === "manageAgent") {
      const originalSocket = this.socket;
      const originalCredential = this.config.nodeCredential;
      const preparedOperation = ["prepared_delivery", "reconcile_prepared_delivery"].includes(message.operation);
      this.queueOperation(async () => {
        try {
          if (preparedOperation && (!this.connected || this.socket !== originalSocket || this.config.nodeCredential !== originalCredential)) throw new Error("Original Manager connection changed before queued delivery execution.");
          let result;
          if (message.operation === "list") result = agentCatalog(this.config);
          else if (message.operation === "configure") {
            const next = configureInstanceAgent(this.config, message.params);
            const agentId = message.params?.agentId;
            if (agentId && this.taskByThread.has(instanceAgents(this.config).find(agent => agent.agentId === agentId)?.sessionId)) throw new Error("Wait for this Agent's running task before changing its binding.");
            writePrivateJson(this.configPath, next);
            this.config = next;
            result = agentCatalog(next);
            this.send({ type: "agentCatalog", agents: result });
          } else {
            const { manageInstanceAgent, EndpointTransportReceipts, sameAgentEndpoint } = await import("./runtime/management.mjs");
            const agent = instanceAgents(this.config).find(agent => agent.agentId === message.params?.agentId);
            const initializeNew = !agent && message.params?.agentId === "new-agent" && ["resolve", "create"].includes(message.params?.action) && !message.params?.prompt;
            if (message.operation === "threads" && (!agent || (!this.config.nodeCredential && agent.enabled === false)) && !initializeNew) throw new Error("The instance Agent is missing or disabled.");
            if (message.operation === "threads" && agent && this.config.nodeCredential) {
              if (!this.connected) throw new Error("Manager connection is unavailable; queued operation was refused.");
              const authority = await createManagerClient({ config: this.config, configPath: this.configPath, agentId: agent.agentId }).invoke("GET", "/meta");
              if (!authority.ok || authority.uncertain || authority.identityChanged) throw new Error("Manager no longer authorizes this Agent operation.");
            }
            const provider = agent?.provider === "codex-desktop" ? "codex" : agent?.provider;
            if (provider && message.params?.agentAdapter && message.params.agentAdapter !== provider) throw new Error("The operation provider does not match the instance Agent.");
            const dsh = (message.operation === "scan" || initializeNew) && message.params?.dshBaseUrl ? normalizeDshBinding({ baseUrl: message.params.dshBaseUrl, sessionId: "scan" }) : agent?.dsh || this.config.dsh;
            const params = { ...message.params, ...(provider ? { provider, agentAdapter: provider } : {}) };
            if (message.operation === "threads" && params.cwd) params.cwd = resolveTaskWorkspace(params.cwd, this.config);
            let endpointExecution;
            if (preparedOperation) {
              const delivery = params.delivery;
              const assertAuthorized = async () => {
                if (!this.connected || this.socket !== originalSocket || this.config.nodeCredential !== originalCredential || !this.config.nodeCredential) throw new Error("Authenticated Manager connection is required for prepared delivery.");
                const current = instanceAgents(this.config).find(item => item.agentId === params.agentId);
                const endpoint = delivery?.target;
                const currentProvider = current?.provider === "codex-desktop" ? "codex" : current?.provider;
                if (!current || endpoint?.kind !== "instance" || endpoint.nodeId !== this.config.nodeId
                  || endpoint.agentId !== current.agentId || endpoint.provider !== currentProvider
                  || !(endpoint.sessionId === current.sessionId || current.managedSessionIds?.includes(endpoint.sessionId))) throw new Error("Prepared endpoint no longer matches the exact enabled instance owner.");
                const authority = await createManagerClient({ config: this.config, configPath: this.configPath, agentId: current.agentId })
                  .invoke("GET", `/api/agent/delivery-authority?deliveryId=${encodeURIComponent(delivery.deliveryId)}&generation=${encodeURIComponent(delivery.generation)}`);
                if (!authority.ok || authority.uncertain || authority.identityChanged) throw new Error("Original delivery authority is unavailable; operation was refused.");
                let body; try { body = JSON.parse(authority.body); } catch { throw new Error("Invalid delivery authority response."); }
                const proof = body.data || body;
                if (proof.authorized !== true || proof.deliveryId !== delivery.deliveryId || proof.generation !== delivery.generation
                  || proof.promptHash !== delivery.promptHash || proof.executionOptionsHash !== delivery.executionOptionsHash || !sameAgentEndpoint(proof.endpoint, endpoint)
                  || !["dispatching", "committed"].includes(proof.state)) throw new Error("Original delivery incarnation or reservation is no longer authorized.");
                if (!this.connected || this.socket !== originalSocket || this.config.nodeCredential !== originalCredential) throw new Error("Original Manager connection changed during delivery authority verification.");
              };
              await assertAuthorized();
              const receipts = new EndpointTransportReceipts(path.join(path.dirname(this.configPath), "endpoint-transport-receipts"));
              endpointExecution = { endpoint: delivery.target, assertAuthorized,
                readReceipt: prepared => receipts.readReceipt(prepared),
                beginAttempt: prepared => receipts.beginAttempt(prepared),
                writeReceipt: (prepared, receipt) => receipts.writeReceipt(prepared, receipt) };
            }
            result = await manageInstanceAgent(message.operation, params, { ...this.config, dsh, endpointExecution, rootDir: path.dirname(fileURLToPath(import.meta.url)) });
            if (agent && message.operation === "threads" && result.statusCode < 400 && ["resolve", "create"].includes(message.params?.action)) {
              const next = registerManagedSession(this.config, agent.agentId, result.data?.thread?.id);
              if (next !== this.config) {
                writePrivateJson(this.configPath, next);
                this.config = next;
                this.send({ type: "agentCatalog", agents: agentCatalog(next) });
              }
            }
          }
          if (!preparedOperation || (this.connected && this.socket === originalSocket && this.config.nodeCredential === originalCredential)) this.send({ type: "managementResult", requestId: message.requestId, result });
        } catch (error) { if (!preparedOperation || (this.connected && this.socket === originalSocket && this.config.nodeCredential === originalCredential)) this.send({ type: "managementResult", requestId: message.requestId, error: boundedText(error instanceof Error ? error.message : String(error), 1024) }); }
      });
      return;
    }
    if (message.type === "updateAvailable" && this.config.autoUpdate !== false && !this.candidatePending) {
      void this.update(String(message.version || "")).catch(error => this.send({ type: "updateResult", status: "failed", error: boundedText(error instanceof Error ? error.message : String(error), 1024) }));
    }
  }

  enqueueTask(task) {
    const taskId = String(task.taskId || "").trim();
    if (!taskId) return;
    const known = this.stateStore.state.tasks[taskId];
    if (known && !["completed", "failed"].includes(known.status)) {
      this.send({ type: "progress", taskId, summary: "This task was already accepted; it will not be submitted twice." });
      return;
    }
    if (known?.status === "completed" || known?.status === "failed") {
      this.send({ type: "taskResult", taskId, status: known.status, summary: known.summary || "Rabi Agent deduplicated an already terminal task.", error: known.error });
      return;
    }
    this.queueOperation(() => this.runTask(task));
  }

  async runTask(task) {
    const taskId = String(task.taskId || "").trim();
    if (this.stateStore.state.tasks[taskId]) return;
    let activeAgent;
    this.send({ type: "ackTask", taskId });
    rememberTask(this.stateStore, taskId, { status: "acknowledged" });
    try {
      if (!this.connected) throw new Error("Manager connection is unavailable; queued task execution was refused.");
      const agent = resolveInstanceAgent(this.config, task);
      activeAgent = agent;
      const cwd = resolveTaskWorkspace(task.cwd || agent.workspace, { defaultWorkspace: this.config.defaultWorkspace, allowedWorkspaces: this.config.allowedWorkspaces });
      const prompt = String(task.message || "").trim();
      if (!prompt) throw new Error("Rabi Agent task message is empty.");
      // Queued work may outlive a grant revocation. Re-check Manager authority at
      // execution time; connection identity alone does not authorize a host turn.
      const authority = await createManagerClient({ config: this.config, configPath: this.configPath, agentId: agent.agentId }).invoke("GET", "/meta");
      if (!authority.ok || authority.uncertain || authority.identityChanged) throw new Error("Manager no longer authorizes this Agent task; host execution was refused.");
      if (agent.provider === "dsh") {
        await sendDshTask(agent.dsh, prompt);
        this.agentExecutionStatus.set(agent.agentId, "宿主已接收");
        this.send({ type: "progress", taskId, summary: "DSH accepted the message into the bound session queue. Read the response in that DSH session." });
        rememberTask(this.stateStore, taskId, { status: "progress" });
        return;
      }
      if (this.taskByThread.has(agent.sessionId)) throw new Error("The bound Codex task is busy. Wait for its current task to finish before submitting another message.");
      this.taskByThread.set(agent.sessionId, taskId);
      await this.desktop.startTurn({
        threadId: agent.sessionId,
        prompt,
        cwd,
        model: agent.model,
        reasoningEffort: agent.reasoningEffort
      });
      this.agentExecutionStatus.set(agent.agentId, "宿主已接收");
      this.send({ type: "progress", taskId, summary: "Codex Desktop accepted the task. Rabi Agent is waiting for its task state." });
      rememberTask(this.stateStore, taskId, { status: "progress" });
    } catch (error) {
      if (activeAgent) this.agentExecutionStatus.set(activeAgent.agentId, "投递失败");
      const message = boundedText(error instanceof Error ? error.message : String(error));
      for (const [threadId, ownerTaskId] of this.taskByThread) if (ownerTaskId === taskId) this.taskByThread.delete(threadId);
      this.send({ type: "taskResult", taskId, status: "failed", error: message });
      rememberTask(this.stateStore, taskId, { status: "failed", error: message });
    }
  }

  handleDesktopBroadcast(event) {
    if (event?.method !== "thread-stream-state-changed") return;
    const params = event.params && typeof event.params === "object" ? event.params : {};
    const threadId = String(params.conversationId || params.threadId || "").trim();
    const taskId = this.taskByThread.get(threadId);
    if (!taskId) return;
    const state = JSON.stringify(params.change ?? params);
    if (state.includes('"status":"completed"') || state.includes('"threadRuntimeStatus":{"type":"idle"')) {
      this.taskByThread.delete(threadId);
      this.send({ type: "taskResult", taskId, status: "completed", summary: "Codex Desktop reported that the target task is complete. Open that task owner to read its response." });
      rememberTask(this.stateStore, taskId, { status: "completed", summary: "Codex Desktop reported task completion." });
    } else if (state.includes('"status":"failed"') || state.includes('"status":"interrupted"')) {
      this.taskByThread.delete(threadId);
      this.send({ type: "taskResult", taskId, status: "failed", error: "Codex Desktop reported that the target task did not complete." });
      rememberTask(this.stateStore, taskId, { status: "failed", error: "Codex Desktop reported task failure." });
    }
  }

  update(requestedVersion) {
    if (this.updatePromise) return this.updatePromise;
    this.updatePromise = this.performUpdate(requestedVersion).then(result => {
      this.desktopSummary = this.connected ? "已连接主机" : "等待连接主机";
      return result;
    }, error => {
      this.desktopSummary = "连接器更新失败，保留当前版本";
      throw error;
    }).finally(() => { this.updatePromise = null; this.publishDesktop(); });
    this.publishDesktop("正在更新连接器");
    return this.updatePromise;
  }

  async drainTasks() {
    const deadline = Date.now() + 30_000;
    while (true) {
      if (this.stopped) throw new Error("Rabi Agent update was stopped.");
      const queue = this.taskQueue;
      let settled = false;
      queue.catch(() => undefined).then(() => { settled = true; });
      while (!settled || this.taskByThread.size || this.terminals.activeCount || this.computer.activeCount) {
        if (this.stopped || Date.now() >= deadline) throw new Error("Running Agent work did not drain within 30 seconds; the current version remains active.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (queue === this.taskQueue) return;
    }
  }

  async pauseConnection() {
    this.connectionPaused = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    clearInterval(this.heartbeatTimer);
    const socket = this.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise((resolve, reject) => {
        const close = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { socket.removeEventListener("close", close); reject(new Error("Old node connection did not close; candidate was not activated.")); }, 5000);
        socket.addEventListener("close", close, { once: true });
        socket.close(1000, "Rabi Agent update handoff");
      });
    }
    this.socket = null;
    this.connected = false;
  }

  async performUpdate(requestedVersion) {
    if (!this.connected || this.stopped || this.candidatePending) throw new Error("Rabi Agent cannot update while it is disconnected from Manager or awaiting commit.");
    this.send({ type: "updateResult", status: "updating" });
    const release = await fetchReleaseManifest(this.config);
    if (requestedVersion && release.version !== requestedVersion) throw new Error(`Manager requested Rabi Agent ${requestedVersion}, but published ${release.version}.`);
    if (readInstalledDigest(fileURLToPath(import.meta.url)) === releaseDigest(release)) {
      this.send({ type: "updateResult", status: "updated" });
      return;
    }
    const entrypoint = await installRelease(this.config, release, this.configPath);
    const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!fs.existsSync(npmCli)) throw new Error("Node.js npm CLI is missing; update this instance using a fresh installation prompt.");
    await new Promise((resolve, reject) => {
      const installer = spawn(process.execPath, [npmCli, "install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: path.dirname(entrypoint), windowsHide: true, stdio: "ignore" });
      const timer = setTimeout(() => { installer.kill(); reject(new Error("Instance dependency installation timed out.")); }, 120_000);
      installer.once("error", error => { clearTimeout(timer); reject(error); });
      installer.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Instance dependency installation failed.")); });
    });
    await this.handoffRelease(entrypoint, releaseDigest(release));
  }

  async handoffRelease(entrypoint, digest) {
    const sharedPaths = [launcherPath(this.configPath), path.join(path.dirname(this.configPath), "hook-client.mjs"), currentReleasePath(this.configPath)];
    const previous = sharedPaths.map(filename => ({ filename, bytes: fs.existsSync(filename) ? fs.readFileSync(filename) : null }));
    const candidate = spawnUpdateCandidate(entrypoint, this.configPath);
    let committed = false;
    let sharedChanged = false;
    try {
      const prepared = await candidate.wait("candidatePrepared");
      if (prepared.nodeId !== this.config.nodeId) throw new Error("Candidate node identity mismatch.");
      this.draining = true;
      await this.drainTasks();
      await this.pauseConnection();
      if (this.stopped) throw new Error("Rabi Agent update was stopped.");
      await candidate.send("activateCandidate");
      const ready = await candidate.wait("candidateConnected");
      if (ready.nodeId !== this.config.nodeId || this.stopped) throw new Error("Candidate readiness no longer matches the active node.");
      sharedChanged = true;
      writeLauncher(this.configPath);
      writeCurrentRelease(this.configPath, entrypoint, digest);
      await candidate.send("commitCandidate");
      await candidate.wait("candidateCommitted");
      // Disconnect is the final release fence: the candidate cannot execute or
      // report updated until the pointer has committed and this fence opens.
      await candidate.release();
      committed = true;
      this.stop();
      if (process.env.RABI_AGENT_SUPERVISED === "1" && process.connected) process.disconnect();
    } catch (error) {
      // Never reconnect the old owner while an unconfirmed candidate may live.
      await candidate.terminate();
      for (const { filename, bytes } of sharedChanged ? previous : []) {
        if (bytes === null) fs.rmSync(filename, { force: true });
        else {
          const temporary = `${filename}.${process.pid}.rollback`;
          fs.writeFileSync(temporary, bytes, { mode: 0o600 });
          fs.renameSync(temporary, filename);
        }
      }
      this.draining = false;
      this.connectionPaused = false;
      if (!this.stopped && !this.connected) this.scheduleReconnect();
      throw error;
    } finally {
      if (committed) await candidate.release();
    }
  }
}

const ARGS = process.argv.slice(2);
const CONFIG_PATH = configPathFromArgs(ARGS);

async function main() {
  const minimumNodeVersion = String(packageJson.engines.node).replace(/^>=/, "");
  if (!versionAtLeast(process.versions.node, minimumNodeVersion)) throw new Error(`Rabi Agent requires Node.js ${minimumNodeVersion} or newer.`);
  if (ARGS.includes("--api") || ARGS.includes("--upload")) {
    const receipt = await runManagerCommand(ARGS, CONFIG_PATH, { readInput: async () => {
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf8");
    } });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    if (!receipt.ok || receipt.uncertain) process.exitCode = 1;
    return;
  }
  if (ARGS.includes("--bootstrap")) {
    await bootstrapConfig(CONFIG_PATH);
    initializeCurrentRelease(CONFIG_PATH, fileURLToPath(import.meta.url));
    const startup = await configureCurrentUserStartup(fileURLToPath(import.meta.url), CONFIG_PATH, { activate: true });
    if (startup.diagnostic) process.stderr.write(`Rabi Agent startup: ${startup.diagnostic}\n`);
    // Enrollment enters the owner in this process, rather than retaining a
    // second long-lived bootstrap parent above the stable main program.
    await stableLauncher(CONFIG_PATH, { baseDelayMs: 1000, maxDelayMs: 30000, maxRestarts: 5, stableMs: 60000 });
    return;
  }
  if (process.env.RABI_AGENT_SUPERVISED === "1" && (!process.send || !process.connected)) {
    throw new Error("Owned connector requires the main program IPC; no independent child was started.");
  }
  const loadedConfig = readConfig(CONFIG_PATH);
  if (!UPDATE_CANDIDATE && process.env.RABI_AGENT_SUPERVISED !== "1") {
    // Direct --run shares the stable owner too. Never reset an update pointer
    // simply because an obsolete release entrypoint was launched manually.
    initializeCurrentRelease(CONFIG_PATH, fileURLToPath(import.meta.url));
    writeLauncher(CONFIG_PATH);
    await stableLauncher(CONFIG_PATH, { baseDelayMs: 1000, maxDelayMs: 30000, maxRestarts: 5, stableMs: 60000 });
    return;
  }
  const runtime = new RabiAgentRuntime(loadedConfig, CONFIG_PATH);
  if (UPDATE_CANDIDATE) {
    if (!process.send || !process.connected) throw new Error("Update candidate requires the parent IPC handoff.");
    let commitAccepted = false;
    const abortCandidate = () => {
      clearTimeout(deadline);
      process.stderr.write("Rabi Agent candidate commit verification failed; exiting for owner recovery.\n");
      // After launcher promotion the old owner cannot roll back this worker.
      // Release IPC and exit abnormally so the stable owner can recover without
      // changing identities/bindings or replaying any previously accepted work.
      process.exitCode = 1;
      try { runtime.stop(); }
      finally {
        if (process.connected) process.disconnect();
        // Let Windows IPC/WebSocket close callbacks finish before process exit.
        // A stalled close still cannot retain the promoted worker indefinitely.
        setTimeout(() => process.exit(1), 5000).unref();
      }
    };
    const deadline = setTimeout(abortCandidate, 90_000);
    const finishCommit = () => {
      if (!runtime.candidatePending) return;
      const current = readJson(currentReleasePath(CONFIG_PATH), null);
      const entrypoint = fileURLToPath(import.meta.url);
      if (!commitAccepted || runtime.stopped || !runtime.connected || runtime.socket?.readyState !== WebSocket.OPEN
        || typeof current?.entrypoint !== "string" || path.resolve(current.entrypoint) !== entrypoint || current.digest !== readInstalledDigest(entrypoint)) {
        abortCandidate(); return;
      }
      clearTimeout(deadline);
      runtime.candidatePending = false;
      runtime.send({ type: "updateResult", status: "updated" });
      runtime.publishDesktop("已连接主机");
    };
    process.on("message", message => {
      if (message?.type === "launcherCommitted" && process.env.RABI_AGENT_SUPERVISED === "1") finishCommit();
      if (message?.type === "activateCandidate") {
        // Queued management and task receipts may have changed after PREPARED.
        // Reload only at the exclusive activation boundary, never copy old state.
        try {
          runtime.config = readConfig(CONFIG_PATH);
          runtime.stateStore = createAgentState(CONFIG_PATH);
          runtime.start();
        } catch { abortCandidate(); }
      }
      if (message?.type === "commitCandidate" && runtime.connected && !runtime.stopped) {
        commitAccepted = true;
        process.send({ type: "candidateCommitted", nodeId: runtime.config.nodeId });
      }
    });
    process.once("disconnect", () => {
      if (process.env.RABI_AGENT_SUPERVISED === "1") { clearTimeout(deadline); runtime.stop(); }
      else finishCommit();
    });
    process.send({ type: "candidatePrepared", nodeId: runtime.config.nodeId });
  } else {
    writeLauncher(CONFIG_PATH);
    runtime.start();
  }
  const stop = () => { runtime.stop(); if (process.connected) process.disconnect(); };
  process.on("message", message => {
    if (message?.type === "desktopRefresh") runtime.publishDesktop();
    if (message?.type === "desktopReconnect") runtime.reconnect();
  });
  if (process.env.RABI_AGENT_SUPERVISED === "1") process.once("disconnect", () => runtime.stop());
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    process.stderr.write(`Rabi Agent failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export const __test = { releaseDigest, readInstalledDigest, installRelease, safeRelativePath, versionAtLeast, managerWebSocketUrl, verifyReleaseManifest, manifestPayload, publicKeySha256, bootstrapConfig, readConfig, authorizedFetch, verifyNodeIdentity, writeLauncher, writeCurrentRelease, initializeCurrentRelease, startupCommand, startupFiles, configureCurrentUserStartup, spawnUpdateCandidate, RabiAgentRuntime };
