import { createTimeoutSettings } from "./lib/timeout-settings.mjs";
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installReleaseDependencies, ensureNativeTerminalDependencies } from "./lib/release-dependencies.mjs";
import { fileURLToPath } from "node:url";
import { CodexDesktopIpcClient } from "./lib/codex-desktop-ipc.mjs";
import { normalizeDshBinding, sendDshTask } from "./lib/dsh.mjs";
import { runManagerCommand } from "./lib/manager-cli.mjs";
import { createManagerClient, createManagerTransport } from "./lib/manager-client.mjs";
import { DeliveryOwner } from "./lib/delivery-owner.mjs";
import { runDeliveryCommand } from "./lib/delivery-control.mjs";
import { createEndpointSession, EndpointAuthenticationError } from "./lib/endpoint-session.mjs";
import { createDesktopPresentation } from "./lib/desktop-presentation.mjs";
import { TerminalService } from "./lib/terminal-service.mjs";
import { ComputerService } from "./lib/computer-service.mjs";
import { uploadHistoryDirectory } from "./lib/upload-history-store.mjs";
import { instanceAgents, agentCatalog, configureInstanceAgent, resolveInstanceAgent, withoutSessionBindings } from "./lib/instance-agents.mjs";
import { normalizeAllowedWorkspaces, resolveRealDirectory, resolveTaskWorkspace } from "./lib/cwd-policy.mjs";

const packageJson = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const AGENT_VERSION = String(packageJson.version || "0.0.0");
const UPDATE_CANDIDATE = process.env.RABI_AGENT_UPDATE_CANDIDATE === "1";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_MS = 15_000;
const TASK_HISTORY_LIMIT = 500;
const MANAGEMENT_READ_LIMIT = 4;

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
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const canonical = fs.existsSync(configPath) ? fs.realpathSync.native(configPath)
    : path.join(fs.realpathSync.native(path.dirname(configPath)), path.basename(configPath));
  const hash = sha256(Buffer.from(process.platform === "win32" ? canonical.toLowerCase() : canonical));
  const owner = net.createServer(socket => socket.destroy());
  const target = process.platform === "win32" ? `\\\\.\\pipe\\rabi-agent-bootstrap-${hash}`
    : { host: "127.0.0.1", port: 32768 + (Number.parseInt(hash.slice(0, 8), 16) % 16384), exclusive: true };
  await new Promise((resolve, reject) => {
    owner.once("error", () => reject(new Error("Connection setup is already running or its local ownership address is busy. No enrollment was sent.")));
    owner.listen(target, resolve);
  });
  try { return await bootstrapLockedConfig(canonical, fetcher); }
  finally { await new Promise(resolve => owner.close(resolve)); }
}

async function bootstrapLockedConfig(configPath, fetcher) {
  const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : undefined;
  const previous = readJson(configPath, undefined);
  if (fs.existsSync(configPath) && !previous) throw new Error("The existing instance configuration is invalid; refusing to replace its identity.");
  const managerUrl = normalizeManagerUrl(process.env.RABI_MANAGER_URL || previous?.managerUrl);
  const ticket = String(process.env.RABI_AGENT_BOOTSTRAP_TICKET || "").trim();
  delete process.env.RABI_AGENT_BOOTSTRAP_TICKET;
  const recoveryPath = `${configPath}.enrollment.json`;
  let recovery = readJson(recoveryPath, undefined);
  if (fs.existsSync(recoveryPath) && (!recovery || recovery.managerUrl !== managerUrl
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(recovery.nodeId || "")
    || !/^[A-Za-z0-9_-]{43}$/.test(recovery.secret || "")
    || (previous?.nodeId && recovery.nodeId !== previous.nodeId))) {
    throw new Error("Connection recovery record does not match this Manager and node. Existing configuration was retained.");
  }
  const commit = config => {
    const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : undefined;
    if (current !== original) throw new Error("Configuration changed during connection setup; rerun bootstrap to recover without replacing its bindings.");
    delete config.lanLinkToken; delete config.bootstrapTicket;
    const migrated = withoutSessionBindings(config);
    if (original && JSON.stringify(JSON.parse(original)) !== JSON.stringify(withoutSessionBindings(JSON.parse(original)))) {
      const backup = configPath + ".before-explicit-sessions-" + randomUUID() + ".json";
      fs.writeFileSync(backup, original, { mode: 0o600, flag: "wx" });
      if (fs.readFileSync(backup,"utf8") !== original) throw new Error("Migration snapshot verification failed.");
    }
    writePrivateJson(configPath, migrated);
    fs.rmSync(recoveryPath, { force: true });
    return migrated;
  };
  // Validate saved credentials before deciding whether this paste needs its ticket.
  if (previous?.nodeCredential && !recovery) {
    const config = { ...previous, managerUrl };
    try {
      await verifyNodeIdentity(config, fetcher);
      return commit(config);
    } catch (error) {
      if (!(error instanceof EndpointAuthenticationError) || (!ticket && !recovery)) throw error;
    }
  }
  if (!ticket && !recovery) throw new Error(previous?.lanLinkToken ? "Legacy lanLinkToken is not accepted; re-enroll using a fresh RABI_AGENT_BOOTSTRAP_TICKET. Existing identities are preserved." : "RABI_AGENT_BOOTSTRAP_TICKET is required for bootstrap.");
  const defaultWorkspace = resolveRealDirectory(previous?.defaultWorkspace || process.env.RABI_AGENT_DEFAULT_CWD || process.cwd(), "RABI_AGENT_DEFAULT_CWD");
  const allowedWorkspaces = normalizeAllowedWorkspaces(parseWorkspaceList(process.env.RABI_AGENT_ALLOWED_CWDS, defaultWorkspace), defaultWorkspace);

  const releasePublicKeySha256 = normalizedPublicKeySha256(process.env.RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256);
  const config = {
    ...previous,
    schemaVersion: 1,
    dsh: previous?.dsh ? { baseUrl: previous.dsh.baseUrl } : undefined,
    managerUrl,
    autoUpdate: previous?.autoUpdate !== false,
    nodeId: previous?.nodeId || recovery?.nodeId || String(process.env.RABI_NODE_ID || "").trim() || randomNodeId(),
    releasePublicKeySha256,
    managerGuid: String(previous?.managerGuid || "").trim() || undefined,
    applicationGenerationId: String(previous?.applicationGenerationId || "").trim() || undefined,
    managerInstanceId: String(previous?.managerInstanceId || "").trim() || undefined,
    defaultWorkspace,
    allowedWorkspaces,

  };
  // Reconnecting an installed computer must not erase its Agent identities or permitted projects.
  if (previous) {
    config.agents = instanceAgents(previous);
    config.allowedWorkspaces = normalizeAllowedWorkspaces([...(previous.allowedWorkspaces || []), ...allowedWorkspaces], defaultWorkspace);
  }
  config.agents ??= [];
  delete config.lanLinkToken;
  delete config.bootstrapTicket;
  if (!recovery) {
    recovery = { managerUrl, nodeId: config.nodeId, secret: randomBytes(32).toString("base64url") };
    writePrivateJson(recoveryPath, recovery);
  } else {
    const recovered = { ...config, nodeCredential: `lan1:${config.nodeId}:${recovery.secret}` };
    try {
      await verifyNodeIdentity(recovered, fetcher);
      return commit(recovered);
    } catch (error) {
      if (!(error instanceof EndpointAuthenticationError)) throw error;
    }
  }
  config.nodeCredential = `lan1:${config.nodeId}:${recovery.secret}`;
  let response;
  let body;
  try {
    response = await fetcher(`${managerUrl}/api/lan-agent/enroll`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket, nodeId: config.nodeId, enrollmentSecret: recovery.secret })
    });
    body = await response.json();
  } catch {
    // The desired credential was saved before POST. A lost response is resolved
    // by authenticating that exact credential, without replaying a new exchange.
    try { await verifyNodeIdentity(config, fetcher); }
    catch { throw new Error("Connection result is uncertain; local recovery information was retained. Rerun the same bootstrap to check the original exchange automatically. No separate approval is required."); }
    return commit(config);
  }
  if (!response.ok || body?.code !== 0) {
    if (response.status >= 500 || body?.uncertain) {
      try { await verifyNodeIdentity(config, fetcher); return commit(config); } catch { /* Retain the exact recovery proof. */ }
    }
    throw new Error(`Enrollment failed (HTTP ${response.status}); local recovery information was retained. If the ticket expired, copy a fresh connection prompt; no additional Agent approval is required.`);
  }
  if (body.data?.nodeId !== config.nodeId || body.data?.token !== config.nodeCredential) throw new Error("Enrollment returned an invalid node identity; result uncertain. Keep the local recovery record and rerun bootstrap.");
  await verifyNodeIdentity(config, fetcher);
  return commit(config);
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
  const timeout = (key, fallback) => {
    const value = JSON.parse(fs.readFileSync(configPath, "utf8")).timeoutOverridesCache?.[key];
    return Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : fallback;
  };
  const forwarded = args.filter((value, i) => value !== "--bootstrap" && i !== index && (index < 0 || i !== index + 1));
  const currentPath = path.join(path.dirname(configPath), "current-release.json");
  const configHash = createHash("sha256").update(process.platform === "win32" ? configPath.toLowerCase() : configPath).digest("hex");
  const diagnosticPath = path.join(path.dirname(configPath), `launcher-control-${configHash}.json`);
  const currentEntry = () => {
    const pointer = JSON.parse(fs.readFileSync(currentPath, "utf8"));
    if (!pointer.entrypoint || !fs.statSync(pointer.entrypoint).isFile()) throw new Error("Current release is missing.");
    return path.resolve(pointer.entrypoint);
  };
  if (forwarded.includes("--api") || forwarded.includes("--operation") || forwarded.includes("--upload") || forwarded.some(arg => ["--delivery-submit", "--delivery-query", "--delivery-list"].includes(arg))) {
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
      socket.setTimeout(timeout("agent.launcher.command",12000), () => socket.destroy(new Error("Launcher stop timed out; result uncertain.")));
      socket.once("connect", () => {
        if (diagnostic?.configHash !== configHash || !/^[a-f0-9]{64}$/.test(diagnostic?.token || "")) {
          socket.destroy(new Error("Launcher stop identity is unavailable; no stop sent.")); return;
        }
        socket.write(`hello ${nonce}\n`);
      });
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        buffer += chunk;
        // Status includes the bounded history; the owner handshake stays small.
        const responseLimit = authenticated && requestedCommand ? 2 * 1024 * 1024 : 512;
        if (buffer.length > responseLimit) { socket.destroy(new Error("Invalid launcher control response.")); return; }
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
  const deliveryControls = new Map();
  const control = net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding("utf8"); // JSON envelopes may split a Unicode code point across pipe packets.
    socket.setTimeout(timeout("agent.launcher.handshake",10000), () => socket.destroy());
    let buffer = ""; let nonce;
    socket.on("data", bytes => {
      buffer += bytes.toString();
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { socket.destroy(); return; }
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
        } else if (nonce && line.startsWith("{")) {
          let frame, request;
          try {
            frame = JSON.parse(line);
            if (frame.type !== "deliveryControl" || typeof frame.body !== "string"
              || frame.proof !== proof(token, `delivery:${createHash("sha256").update(frame.body).digest("hex")}`, nonce)) throw new Error("Invalid delivery control proof.");
            request = JSON.parse(frame.body);
            if (!/^[a-f0-9-]{36}$/i.test(request.requestId) || !["submit", "query"].includes(request.operation)) throw new Error("Invalid delivery control request.");
          } catch { socket.destroy(); return; }
          nonce = undefined;
          if (!worker?.connected || stopping || transitioning || paused || candidate) {
            socket.end(JSON.stringify({ requestId: request.requestId, ok: false, accepted: false, error: "DELIVERY_OWNER_UNAVAILABLE" }) + "\n"); return;
          }
          const timer = setTimeout(() => {
            deliveryControls.delete(request.requestId);
            socket.end(JSON.stringify({ requestId: request.requestId, ok: false, accepted: null, error: "DELIVERY_LOCAL_ACCEPTANCE_UNKNOWN" }) + "\n");
          }, timeout("agent.launcher.delivery",12000));
          deliveryControls.set(request.requestId, { socket, timer, worker });
          worker.send({ type: "deliveryControl", ...request }, error => {
            if (!error) return;
            const pending = deliveryControls.get(request.requestId); if (!pending) return;
            clearTimeout(pending.timer); deliveryControls.delete(request.requestId);
            socket.end(JSON.stringify({ requestId: request.requestId, ok: false, accepted: null, error: "DELIVERY_LOCAL_ACCEPTANCE_UNKNOWN" }) + "\n");
          });
          return;
        } else { socket.destroy(); return; }
      }
    });
    socket.once("close", () => {
      sockets.delete(socket); stopWaiters.delete(socket);
      for (const [id, pending] of deliveryControls) if (pending.socket === socket) { clearTimeout(pending.timer); deliveryControls.delete(id); }
    });
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
    stopDeadline = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, timeout("agent.launcher.stop",5000));
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
      if (message?.type === "deliveryControlResult") {
        const pending = deliveryControls.get(message.requestId);
        if (pending?.worker !== child) return;
        clearTimeout(pending.timer); deliveryControls.delete(message.requestId);
        pending.socket.end(JSON.stringify({ ...message.result, requestId: message.requestId }) + "\n");
      } else if (message?.type === "desktopSnapshot") {
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
      const deadline = setTimeout(() => owned.kill("SIGKILL"), timeout("agent.launcher.stop",5000));
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
    timeout,
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

function startupFiles(platform, executable, script, config, { home, env = {}, uid, stopTimeoutMs = 10000 } = {}) {
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
  add(path.join(directory, "systemd", "user", "rabi-agent.service"), `[Unit]\nDescription=Rabi Agent current-user connector\nStartLimitIntervalSec=300\nStartLimitBurst=5\n[Service]\nType=simple\nExecStart=${[executable, script, "--config", config].map(quote).join(" ")}\nRestart=on-failure\nRestartSec=30\nKillMode=control-group\nTimeoutStopSec=${stopTimeoutMs / 1000}\n[Install]\nWantedBy=default.target\n`);
  return { files, obsolete: [], mode: "user-systemd", activation: [["systemctl", ["--user", "show-environment"]], ["systemctl", ["--user", "daemon-reload"]], ["systemctl", ["--user", "enable", "--now", "rabi-agent.service"]]],
    fallback: { path: path.join(directory, "autostart", "rabi-agent.desktop"), content: startupCommand("linux", executable, script, config) } };
}

function runStartupCommand(executable, args, timeoutMs = 10000) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, diagnostic: "command timed out" }); }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); resolve({ ok: false, diagnostic: error.code }); });
    child.once("exit", code => { clearTimeout(timer); resolve({ ok: code === 0, diagnostic: `exit ${code}` }); });
  });
}

async function configureCurrentUserStartup(_entrypoint, configPath, options = {}) {
  const platform = options.platform || process.platform;
  const script = path.resolve(writeLauncher(configPath));
  const plan = startupFiles(platform, options.executable || process.execPath, script, path.resolve(configPath), {
    home: options.home || os.homedir(), env: options.env || process.env, uid: options.uid ?? process.getuid?.(), stopTimeoutMs: createTimeoutSettings(options.timeoutOverrides).get("agent.startup.serviceStop",10000)
  });
  const write = file => {
    if (fs.existsSync(file.path)) fs.readFileSync(file.path); // Observe before replacement.
    fs.mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file.path, file.encoding === "utf16le" ? `\uFEFF${file.content}` : file.content, { encoding: file.encoding || "utf8", mode: 0o600 });
  };
  plan.files.forEach(write);
  for (const obsolete of plan.obsolete) if (fs.existsSync(obsolete)) { fs.readFileSync(obsolete); fs.unlinkSync(obsolete); }
  if (!options.activate) return { mode: plan.mode, activated: false, diagnostic: "Startup configured; current-user service activation not requested." };
  const run = options.runCommand || ((executable,args) => runStartupCommand(executable,args,createTimeoutSettings(options.timeoutOverrides).get("agent.startup.command",10000)));
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
  const original = fs.readFileSync(configPath, "utf8");
  const previous = JSON.parse(original);
  if (!previous || previous.schemaVersion !== 1) throw new Error("Rabi Agent configuration is missing or invalid.");
  const config = withoutSessionBindings(previous);
  if (JSON.stringify(previous) !== JSON.stringify(config)) {
    if (fs.readFileSync(configPath, "utf8") !== original) throw new Error("Configuration changed during binding retirement; retry from current configuration.");
    fs.writeFileSync(configPath + ".before-explicit-sessions-" + Date.now() + ".json", original, { mode: 0o600, flag: "wx" });
    writePrivateJson(configPath, config);
  }
  const nodeCredential = String(config.nodeCredential || "").trim();
  const nodeId = String(config.nodeId || "").trim();
  if (!nodeCredential || !nodeId) throw new Error("An enrolled computer credential and node ID are required.");
  const defaultWorkspace = resolveRealDirectory(config.defaultWorkspace, "Rabi Agent default workspace");
  return { ...config, managerUrl: normalizeManagerUrl(config.managerUrl), nodeCredential, nodeId,
    releasePublicKeySha256: normalizedPublicKeySha256(config.releasePublicKeySha256, "Rabi Agent release public key fingerprint"),
    autoUpdate: config.autoUpdate !== false, defaultWorkspace,
    allowedWorkspaces: normalizeAllowedWorkspaces(config.allowedWorkspaces, defaultWorkspace) };
}

function createAgentState(configPath) {
  const statePath = path.join(path.dirname(configPath), "state.json");
  const state = readJson(statePath, { schemaVersion: 1, tasks: {} });
  if (state.schemaVersion !== 1 || !state.tasks || typeof state.tasks !== "object") return { statePath, state: { schemaVersion: 1, tasks: {} } };
  return { statePath, state };
}

function rememberTask(store, taskId, value) {
  const managerGuid = store.state.tasks[taskId]?.managerGuid;
  delete store.state.tasks[taskId];
  store.state.tasks[taskId] = { ...(managerGuid ? { managerGuid } : {}), ...value, updatedAt: new Date().toISOString() };
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
  const response = await fetcher(url, { headers: { authorization: `Bearer ${config.nodeCredential}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(createTimeoutSettings(config.timeoutOverridesCache).get("agent.release.request",30000)) });
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

function spawnUpdateCandidate(entrypoint, configPath, timeoutOverrides) {
  const timeouts = createTimeoutSettings(timeoutOverrides);
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
      const deadline = Date.now() + timeouts.get("agent.update.candidate",30000);
      while (!failure && !exited && Date.now() < deadline) {
        if (messages.has(type)) return messages.get(type);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error("Rabi Agent candidate did not connect or acknowledge within the configured timeout; the current version remains active.");
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
      const deadline = Date.now() + timeouts.get("agent.update.exit",5000);
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
    this.managementReads = new Set();
    this.receiptRecoveries = new Set();
    this.managementMutations = new Set();
    this.preparedDeliveries = new Set();
    this.managementMutationQueue = Promise.resolve();
    this.receiptOperations = new Map();
    this.pendingOperations = 0;
    this.taskByThread = new Map();
    this.desktopSummary = "正在连接主机";
    this.lastDesktopTask = "";
    this.agentExecutionStatus = new Map();
    const timeout = (key, fallback) => createTimeoutSettings(this.config.timeoutOverridesCache).get(key, fallback);
    this.timeout = timeout;
    this.computer = new ComputerService({ timeout, uploadHistoryRoot: uploadHistoryDirectory(homeDataDirectory(), configPath), onChange: () => this.publishDesktop() });
    this.terminals = new TerminalService({ timeout, defaultCwd: config.defaultWorkspace, historyDirectory: path.join(path.dirname(configPath), "terminal-history"),
      emit: event => {
        if ((this.socket?.bufferedAmount || 0) > 1048576) {
          void this.terminals.execute({ action: "close", terminalId: event.terminalId }).catch(() => undefined);
          return;
        }
        this.send({ type: "terminalEvent", event });
      }, onChange: () => this.publishDesktop() });
    this.desktop = new CodexDesktopIpcClient({ timeout, onBroadcast: event => this.handleDesktopBroadcast(event) });
  }

  start() {
    if (!this.candidatePending) this.startDeliveryOwner();
    this.connect();
  }

  startDeliveryOwner() {
    if (this.deliveryOwner) return this.deliveryOwner;
    this.deliveryOwner = new DeliveryOwner({ configPath: this.configPath, config: this.config,
      resolveManagerIdentity: async () => {
        const current = readConfig(this.configPath);
        if (current.nodeId !== this.config.nodeId) throw new Error("Original delivery node identity changed.");
        const identity = await verifyNodeIdentity(current, fetch, this.configPath);
        Object.assign(this.config, current); return identity;
      },
      client: (agentType, sessionId, managerGuid) => {
        // Another CLI may have verified and persisted a new endpoint. Reload
        // its hints rather than indefinitely failing CAS from a stale snapshot.
        const current = readConfig(this.configPath);
        if (current.nodeId !== this.config.nodeId) throw new Error("Delivery queue node identity changed; original intents retained.");
        if (!managerGuid || current.managerGuid !== managerGuid) throw new Error("Original delivery Manager changed before transport creation; intent retained.");
        Object.assign(this.config, current);
        return createManagerTransport({ config: current, configPath: this.configPath, agentType, sessionId,
          timeoutMs: current.deliveryPolicy?.requestTimeoutMs ?? 8000 });
      },
      sendEvent: (payload, managerGuid) => this.connected && this.socketManagerGuid === managerGuid && this.sendRaw(payload) });
    this.deliveryOwner.start();
    return this.deliveryOwner;
  }

  deliveryControl(operation, params) {
    if (this.stopped || this.draining || this.candidatePending) throw new Error("DELIVERY_OWNER_UNAVAILABLE");
    const owner = this.startDeliveryOwner();
    return operation === "submit" ? owner.submit(params) : { ok: true, ...owner.query(params) };
  }

  publishDesktop(summary = this.desktopSummary) {
    this.desktopSummary = summary;
    let managerOrigin = "";
    try { managerOrigin = new URL(this.config.managerUrl).origin; } catch { }
    const payload = {
      type: "desktopSnapshot", summary, version: AGENT_VERSION, managerOrigin,
      agents: instanceAgents(this.config).map(agent => `${agent.provider} · ${this.agentExecutionStatus.get(agent.agentId) || "按请求指定会话"}`).join("\n") || "按请求指定 Agent 类型与完整会话 ID",
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
    this.connectionAbort?.abort();
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

  withReceiptOperation(deliveryId, operation) {
    // The persisted ledger is keyed by deliveryId, not Manager generation.
    // Every prepared delivery and recovery shares this actual file owner.
    const receipt = path.resolve(path.dirname(this.configPath), "endpoint-transport-receipts", `${sha256(String(deliveryId ?? ""))}.json`);
    const key = process.platform === "win32" ? receipt.toLowerCase() : receipt;
    const previous = this.receiptOperations.get(key) || Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation).finally(() => {
      if (this.receiptOperations.get(key) === pending) this.receiptOperations.delete(key);
    });
    this.receiptOperations.set(key, pending);
    return pending;
  }

  queueManagementRead(operation, requestId, recovery = false) {
    // Pending recovery for one unhealthy receipt cannot consume metadata slots.
    const owners = recovery ? this.receiptRecoveries : this.managementReads;
    if (owners.size >= MANAGEMENT_READ_LIMIT) {
      this.send({ type: "managementResult", requestId, error: `Instance management ${recovery ? "recovery" : "read"} capacity reached; this read was not started.` });
      return;
    }
    this.pendingOperations++;
    this.publishDesktop();
    const pending = Promise.resolve().then(operation).finally(() => {
      owners.delete(pending);
      this.pendingOperations--;
      this.publishDesktop();
    });
    owners.add(pending);
  }

  queueManagementWrite(operation, requestId, prepared = false) {
    const owners = prepared ? this.preparedDeliveries : this.managementMutations;
    if (owners.size >= MANAGEMENT_READ_LIMIT) {
      this.send({ type: "managementResult", requestId, error: "Instance management " + (prepared ? "delivery" : "mutation") + " capacity reached; this operation was not started." });
      return;
    }
    this.pendingOperations++;
    this.publishDesktop();
    // Metadata mutations retain their existing order. Prepared delivery uses its
    // original receipt-file owner and the host's own execution protocol.
    const previous = prepared ? Promise.resolve() : this.managementMutationQueue;
    const pending = previous.catch(() => undefined).then(operation).finally(() => {
      owners.delete(pending);
      this.pendingOperations--;
      this.publishDesktop();
    });
    owners.add(pending);
    if (!prepared) this.managementMutationQueue = pending;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.terminals.stop()),
        Promise.resolve().then(() => this.computer.stop()),
        Promise.resolve().then(() => this.deliveryOwner?.close())
      ]);
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Rabi Agent resource cleanup failed; original history evidence was retained.");
    });
    // Observe failure even when the supervisor has already disconnected. The
    // original owner promise remains rejected for callers that join shutdown.
    this.stopPromise.catch(error => {
      process.stderr.write("Rabi Agent cleanup failed: " + boundedText(error instanceof Error ? error.message : String(error), 1024) + "\n");
      process.exitCode = 1;
    });
    this.publishDesktop("连接器已停止");
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeatTimer);
    this.connectionAbort?.abort();
    this.socket?.close(1000, "Rabi Agent stopping");
    this.desktop.close();
    return this.stopPromise;
  }

  async connect() {
    if (this.stopped || this.connectionPaused || this.connecting || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.connecting = true;
    this.publishDesktop("正在连接主机");
    const controller = new AbortController(); this.connectionAbort = controller;
    let socket;
    try {
      // A socket belongs to the authenticated Manager captured for this
      // handshake, even if a concurrent CLI replaces the installed config.
      const originalConfig = { ...this.config }, connectionConfig = { ...originalConfig };
      await verifyNodeIdentity(connectionConfig, fetch, fs.existsSync(this.configPath) ? this.configPath : undefined);
      if (this.stopped || this.connectionPaused) return;
      const endpointKeys = ["managerUrl", "managerGuid", "applicationGenerationId", "managerInstanceId"];
      if (["nodeId", "nodeCredential", ...endpointKeys].every(key => this.config[key] === originalConfig[key])) {
        for (const key of endpointKeys) this.config[key] = connectionConfig[key];
        this.config.timeoutOverridesCache = connectionConfig.timeoutOverridesCache;
      }
      const client = createManagerClient({ config: connectionConfig, configPath: fs.existsSync(this.configPath) ? this.configPath : undefined });
      await client.openOperation("manager.lan-agent.connect", { signal: controller.signal,
        onOpen: channel => {
          socket = channel;
          if (this.stopped || this.connectionPaused || controller.signal.aborted) { channel.close(); return; }
          this.socket = channel;
          this.socketManagerGuid = connectionConfig.managerGuid;
          this.send({ type: "authenticate", token: connectionConfig.nodeCredential });
        },
        onMessage: value => { if (this.socket === socket) this.handleManagerMessage(JSON.stringify(value)); },
        onClose: async () => {
          if (this.socket !== socket) return;
          this.connected = false;
          clearInterval(this.heartbeatTimer);
          await this.terminals.closeAll();
          this.scheduleReconnect();
        }
      });
    } catch (error) {
      // EndpointSession already performs bounded stable-GUID rediscovery and
      // persists only verified identities. Never resurrect the old preverify write.
      this.scheduleReconnect(error);
      return;
    } finally { this.connecting = false; }
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
    const taskGuid = payload.taskId && this.stateStore.state.tasks[payload.taskId]?.managerGuid;
    if (payload.taskId && ["ackTask", "progress"].includes(payload.type) && (!taskGuid || taskGuid !== this.socketManagerGuid)) return false;
    if (payload.taskId && ["ackTask", "progress", "taskResult"].includes(payload.type)) {
      const labels = { ackTask: "已接收", progress: "已投递", taskResult: payload.status === "completed" ? "已完成" : "失败" };
      this.lastDesktopTask = `${String(payload.taskId).slice(0, 160)} · ${labels[payload.type]}`;
      this.publishDesktop();
    }
    if (payload.type === "taskResult" && payload.taskId) {
      const knownTask = this.stateStore.state.tasks[payload.taskId];
      this.startDeliveryOwner().enqueueResult(payload, knownTask ? knownTask.managerGuid || null : this.socketManagerGuid || null);
      return true; // Local durable acceptance; receiver ACK is a separate fact.
    }
    return this.sendRaw(payload);
  }

  sendRaw(payload) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    try { this.socket.send(JSON.stringify(payload)); return true; }
    catch { this.socket.close(1000, "Transport unavailable"); return false; }
  }

  handleManagerMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (!message || typeof message !== "object") return;
    if (message.type === "resultAck") {
      if (this.connected && this.deliveryOwner) this.deliveryOwner.acknowledge(message, this.socketManagerGuid || null);
      return;
    }
    if (message.type === "manageAgent" && message.operation === "delivery_records") {
      if (!this.connected || this.candidatePending || this.stopped) return;
      try { this.sendRaw({ type: "managementResult", requestId: message.requestId, result: this.deliveryControl("query", message.params || {}) }); }
      catch { this.sendRaw({ type: "managementResult", requestId: message.requestId, error: "DELIVERY_OWNER_UNAVAILABLE" }); }
      return;
    }
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
        if (this.socket === socket && this.connected) this.send({ type: "managementResult", requestId: message.requestId, error: boundedText(error.message, 512), ...(message.operation === "terminal" && error.code === "TERMINAL_OPEN_NOT_STARTED" ? { errorCode: "TERMINAL_OPEN_NOT_STARTED" } : {}) });
      });
      return;
    }
    if (message.type === "authenticated") {
      this.send({
        type: "hello",
        node: {
          nodeId: this.config.nodeId,
          hostname: os.hostname(),
          version: AGENT_VERSION,
          platform: `${process.platform}-${process.arch}`,
          agentTypes: ["codex-desktop", "dsh"],
          taskTargeting: "explicit-session-v1",
          agents: agentCatalog(this.config),
          terminalShells: this.terminals.shells,
          computerCapabilities: ["files", ...(process.platform === "win32" ? ["windows", "screenshots"] : [])],
          allowedWorkspaces: this.config.allowedWorkspaces
        }
      });
      return;
    }
    if (message.type === "connected") {
      this.connected = true;
      this.deliveryOwner?.wake();
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
      // Independent reads and recovery must not wait behind another owner.
      // Recovery never sends a prompt and shares the exact original receipt lock.
      const independentRead = message.operation === "list" || message.operation === "reconcile_prepared_delivery" || message.operation === "threads"
        && ["list", "read"].includes(message.params?.action ?? "list");
      const dispatch = independentRead
        ? operation => this.queueManagementRead(operation, message.requestId, message.operation === "reconcile_prepared_delivery")
        : operation => this.queueManagementWrite(operation, message.requestId, preparedOperation);
      const schedule = operation => dispatch(preparedOperation
        ? () => this.withReceiptOperation(message.params?.delivery?.deliveryId, operation)
        : operation);
      schedule(async () => {
        try {
          if (preparedOperation && (!this.connected || this.socket !== originalSocket || this.config.nodeCredential !== originalCredential)) throw new Error("Original Manager connection changed before queued delivery execution.");
          let result;
          if (message.operation === "list") result = agentCatalog(this.config);
          else if (message.operation === "configure") {
            const next = configureInstanceAgent(this.config, message.params);
            writePrivateJson(this.configPath, next);
            this.config = next;
            result = agentCatalog(next);
            this.send({ type: "agentCatalog", agents: result });
          } else {
            const { manageInstanceAgent, EndpointTransportReceipts, sameAgentEndpoint } = await import("./runtime/management.mjs");
            const requestedProvider = message.params?.agentAdapter || message.params?.provider || message.params?.delivery?.target?.provider;
            const provider = requestedProvider === "codex-desktop" ? "codex" : requestedProvider;
            if (message.operation === "threads" && !["codex", "dsh"].includes(provider)) throw new Error("Explicit implemented agentAdapter is required.");
            const agent = instanceAgents(this.config).find(agent => (agent.provider === "codex-desktop" ? "codex" : agent.provider) === provider);
            const dsh = message.params?.dshBaseUrl ? { baseUrl: message.params.dshBaseUrl } : agent?.dsh || this.config.dsh;
            const params = { ...message.params, ...(provider ? { provider, agentAdapter: provider } : {}) };
            if (message.operation === "threads" && params.cwd) params.cwd = resolveTaskWorkspace(params.cwd, this.config);
            let endpointExecution;
            if (preparedOperation) {
              const delivery = params.delivery;
              const assertAuthorized = async () => {
                if (!this.connected || this.socket !== originalSocket || this.config.nodeCredential !== originalCredential || !this.config.nodeCredential) throw new Error("Authenticated Manager connection is required for prepared delivery.");
                const endpoint = delivery?.target;
                if (endpoint?.kind !== "instance" || endpoint.nodeId !== this.config.nodeId
                  || endpoint.provider !== provider || !endpoint.sessionId) throw new Error("Prepared endpoint does not match this computer and explicit provider/session.");
                const authority = await createManagerClient({ config: this.config, configPath: this.configPath,
                  agentType: endpoint.provider, sessionId: endpoint.sessionId })
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
                readNotSent: prepared => receipts.readNotSentProof(prepared),
                writeNotSent: (prepared, proof) => receipts.writeNotSent(prepared, proof),
                beginAttempt: prepared => receipts.beginAttempt(prepared),
                writeReceipt: (prepared, receipt) => receipts.writeReceipt(prepared, receipt) };
            }
            result = await manageInstanceAgent(message.operation, params, { ...this.config, dsh, endpointExecution, rootDir: path.dirname(fileURLToPath(import.meta.url)) });

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
    const managerGuid = this.socketManagerGuid;
    const known = this.stateStore.state.tasks[taskId];
    if (known && known.managerGuid !== managerGuid) return;
    if (known && !["completed", "failed"].includes(known.status)) {
      this.send({ type: "progress", taskId, summary: "This task was already accepted; it will not be submitted twice." });
      return;
    }
    if (known?.status === "completed" || known?.status === "failed") {
      this.send({ type: "taskResult", taskId, status: known.status, summary: known.summary || "Rabi Agent deduplicated an already terminal task.", error: known.error });
      return;
    }
    this.queueOperation(() => this.runTask(task, managerGuid));
  }

  async runTask(task, managerGuid) {
    const taskId = String(task.taskId || "").trim();
    if (this.stateStore.state.tasks[taskId]) return;
    let activeAgent;
    rememberTask(this.stateStore, taskId, { status: "acknowledged", managerGuid });
    this.send({ type: "ackTask", taskId });
    try {
      if (!this.connected || !managerGuid || this.socketManagerGuid !== managerGuid) throw new Error("Original Manager connection is unavailable; queued task execution was refused.");
      const agent = resolveInstanceAgent(this.config, task);
      activeAgent = agent;
      const cwd = resolveTaskWorkspace(task.cwd || agent.workspace, { defaultWorkspace: this.config.defaultWorkspace, allowedWorkspaces: this.config.allowedWorkspaces });
      const prompt = String(task.message || "").trim();
      if (!prompt) throw new Error("Rabi Agent task message is empty.");
      // Queued work may outlive a grant revocation. Re-check Manager authority at
      // execution time; connection identity alone does not authorize a host turn.
      const taskConfig = readConfig(this.configPath);
      if (taskConfig.nodeId !== this.config.nodeId || taskConfig.managerGuid !== managerGuid) throw new Error("Original task Manager binding changed before authority verification.");
      const authority = await createManagerClient({ config: taskConfig, configPath: this.configPath, agentType: agent.provider === "codex-desktop" ? "codex" : agent.provider, sessionId: task.threadId }).invoke("GET", "/meta");
      if (!authority.ok || authority.uncertain || authority.identityChanged) throw new Error("Manager no longer authorizes this Agent task; host execution was refused.");
      if (!this.connected || this.socketManagerGuid !== managerGuid) throw new Error("Original Manager connection changed before host task execution.");
      if (agent.provider === "dsh") {
        await sendDshTask({ ...agent.dsh, sessionId: task.threadId }, prompt);
        this.agentExecutionStatus.set(agent.agentId, "宿主已接收");
        this.send({ type: "progress", taskId, summary: "DSH accepted the message into the bound session queue. Read the response in that DSH session." });
        rememberTask(this.stateStore, taskId, { status: "progress" });
        return;
      }
      if (this.taskByThread.has(task.threadId)) throw new Error("The selected Codex task is busy. Wait for its current task to finish before submitting another message.");
      this.taskByThread.set(task.threadId, taskId);
      await this.desktop.startTurn({
        threadId: task.threadId,
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
      this.send({ type: "taskResult", taskId, status: "completed", summary: "Codex Desktop reported that the target task is complete. Open that task owner to read its response." });
      this.taskByThread.delete(threadId);
      rememberTask(this.stateStore, taskId, { status: "completed", summary: "Codex Desktop reported that the target task is complete. Open that task owner to read its response." });
    } else if (state.includes('"status":"failed"') || state.includes('"status":"interrupted"')) {
      this.send({ type: "taskResult", taskId, status: "failed", error: "Codex Desktop reported that the target task did not complete." });
      this.taskByThread.delete(threadId);
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
    const deadline = Date.now() + this.timeout("agent.update.drain",30000);
    while (true) {
      if (this.stopped) throw new Error("Rabi Agent update was stopped.");
      const queue = this.taskQueue;
      let settled = false;
      queue.catch(() => undefined).then(() => { settled = true; });
      while (!settled || this.managementReads.size || this.receiptRecoveries.size || this.managementMutations.size || this.preparedDeliveries.size || this.taskByThread.size || this.terminals.activeCount || this.terminals.pendingOpens || this.computer.activeCount) {
        if (this.stopped || Date.now() >= deadline) throw new Error("Running Agent work did not drain within the configured timeout; the current version remains active.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (queue === this.taskQueue) return;
    }
  }

  async pauseConnection() {
    this.connectionPaused = true;
    this.connectionAbort?.abort();
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    clearInterval(this.heartbeatTimer);
    const socket = this.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise((resolve, reject) => {
        const close = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { socket.removeEventListener("close", close); reject(new Error("Old node connection did not close; candidate was not activated.")); }, this.timeout("agent.connection.close",5000));
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
    await installReleaseDependencies(entrypoint, { timeoutOverrides: this.config.timeoutOverridesCache });
    await this.handoffRelease(entrypoint, releaseDigest(release));
  }

  async handoffRelease(entrypoint, digest) {
    const sharedPaths = [launcherPath(this.configPath), path.join(path.dirname(this.configPath), "hook-client.mjs"), currentReleasePath(this.configPath)];
    const previous = sharedPaths.map(filename => ({ filename, bytes: fs.existsSync(filename) ? fs.readFileSync(filename) : null }));
    const candidate = spawnUpdateCandidate(entrypoint, this.configPath, this.config.timeoutOverridesCache);
    let committed = false;
    let sharedChanged = false;
    try {
      const prepared = await candidate.wait("candidatePrepared");
      if (prepared.nodeId !== this.config.nodeId) throw new Error("Candidate node identity mismatch.");
      this.draining = true;
      await this.deliveryOwner?.pause();
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
      // The successor already owns the committed pointer. Retired-owner cleanup
      // failure is reported by stop(); it cannot roll back or terminate that owner.
      await this.stop().catch(() => undefined);
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
      this.deliveryOwner?.resume();
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
  if (ARGS.some(arg => ["--delivery-submit", "--delivery-query", "--delivery-list"].includes(arg))) {
    const receipt = await runDeliveryCommand(ARGS, CONFIG_PATH, async () => {
      const chunks = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    });
    process.stdout.write(JSON.stringify(receipt) + "\n");
    if (!receipt.ok) process.exitCode = 1;
    return;
  }
  if (ARGS.includes("--api") || ARGS.includes("--operation") || ARGS.includes("--upload")) {
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
    const startup = await configureCurrentUserStartup(fileURLToPath(import.meta.url), CONFIG_PATH, { activate: true, timeoutOverrides: readConfig(CONFIG_PATH).timeoutOverridesCache });
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
  await ensureNativeTerminalDependencies(fileURLToPath(import.meta.url), { timeoutOverrides: loadedConfig.timeoutOverridesCache });
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
        setTimeout(() => process.exit(1), createTimeoutSettings(loadedConfig.timeoutOverridesCache).get("agent.update.exit",5000)).unref();
      }
    };
    const deadline = setTimeout(abortCandidate, createTimeoutSettings(loadedConfig.timeoutOverridesCache).get("agent.update.commit",90000));
    const finishCommit = () => {
      if (!runtime.candidatePending) return;
      const current = readJson(currentReleasePath(CONFIG_PATH), null);
      const entrypoint = fileURLToPath(import.meta.url);
      if (!commitAccepted || runtime.stopped || !runtime.connected || runtime.socket?.readyState !== WebSocket.OPEN
        || typeof current?.entrypoint !== "string" || path.resolve(current.entrypoint) !== entrypoint || current.digest !== readInstalledDigest(entrypoint)) {
        abortCandidate(); return;
      }
      // Only the committed successor can materialize its own launcher code.
      // The retired owner still carries the previous release implementation.
      try { writeLauncher(CONFIG_PATH); } catch { abortCandidate(); return; }
      clearTimeout(deadline);
      runtime.candidatePending = false;
      runtime.startDeliveryOwner();
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
  const stop = () => { void runtime.stop().finally(() => { if (process.connected) process.disconnect(); }).catch(() => undefined); };
  process.on("message", message => {
    if (message?.type === "deliveryControl") {
      try {
        const result = runtime.deliveryControl(message.operation, message.params);
        process.send?.({ type: "deliveryControlResult", requestId: message.requestId, result });
      } catch (error) {
        process.send?.({ type: "deliveryControlResult", requestId: message.requestId,
          result: { ok: false, accepted: false, error: error instanceof Error ? error.message : "DELIVERY_LOCAL_SUBMIT_FAILED" } });
      }
    }
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

export const __test = { releaseDigest, readInstalledDigest, installRelease, safeRelativePath, versionAtLeast, verifyReleaseManifest, manifestPayload, publicKeySha256, bootstrapConfig, readConfig, authorizedFetch, verifyNodeIdentity, writeLauncher, writeCurrentRelease, initializeCurrentRelease, startupCommand, startupFiles, configureCurrentUserStartup, spawnUpdateCandidate, RabiAgentRuntime };
