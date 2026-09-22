import { createHash, createPublicKey, verify } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexDesktopIpcClient } from "./lib/codex-desktop-ipc.mjs";
import { normalizeDshBinding, sendDshTask } from "./lib/dsh.mjs";
import { runManagerCommand } from "./lib/manager-cli.mjs";
import { createManagerClient } from "./lib/manager-client.mjs";
import { createEndpointSession } from "./lib/endpoint-session.mjs";
import { instanceAgents, agentCatalog, configureInstanceAgent, resolveInstanceAgent, registerManagedSession } from "./lib/instance-agents.mjs";
import { normalizeAllowedWorkspaces, resolveRealDirectory, resolveTaskWorkspace } from "./lib/cwd-policy.mjs";

const packageJson = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const AGENT_VERSION = String(packageJson.version || "0.0.0");
const READY_FILE = process.env.RABI_AGENT_READY_FILE?.trim() || "";
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
  const agentType = process.env.RABI_AGENT_TYPE?.trim() || "codex-desktop";
  if (!["codex-desktop", "dsh"].includes(agentType)) throw new Error("Unsupported RABI_AGENT_TYPE.");
  if (agentType === "codex-desktop" && !codexThreadId) throw new Error("RABI_AGENT_CODEX_THREAD_ID is required for Codex Desktop.");
  const dsh = agentType === "dsh" ? normalizeDshBinding({ baseUrl: process.env.RABI_AGENT_DSH_URL, sessionId: process.env.RABI_AGENT_DSH_SESSION_ID }) : undefined;
  const config = {
    schemaVersion: 1,
    agentType,
    dsh,
    managerUrl,
    nodeId: previous?.nodeId || String(process.env.RABI_NODE_ID || "").trim() || randomNodeId(),
    releasePublicKeySha256,
    managerGuid: String(previous?.managerGuid || "").trim() || undefined,
    applicationGenerationId: String(previous?.applicationGenerationId || "").trim() || undefined,
    managerInstanceId: String(previous?.managerInstanceId || "").trim() || undefined,
    defaultWorkspace,
    allowedWorkspaces,
    codexDesktop: {
      threadId: codexThreadId,
      model: String(process.env.RABI_AGENT_CODEX_MODEL || "").trim() || undefined,
      reasoningEffort: String(process.env.RABI_AGENT_CODEX_REASONING || "medium").trim() || "medium"
    }
  };
  // Reconnecting an installed computer must not erase its Agent identities or permitted projects.
  if (previous) {
    config.agents = instanceAgents(previous);
    config.allowedWorkspaces = normalizeAllowedWorkspaces([...(previous.allowedWorkspaces || []), ...allowedWorkspaces], defaultWorkspace);
  }
  config.agents = instanceAgents(config);
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

function launcherPath(configPath) {
  return path.join(path.dirname(configPath), "rabi-agent-launcher.mjs");
}

function writeLauncher(configPath) {
  const hookShim = `import fs from "node:fs";\nimport path from "node:path";\nimport { pathToFileURL } from "node:url";\nexport async function requestInstanceHook(input, configPath, fetcher = fetch) {\n const current = JSON.parse(fs.readFileSync(path.join(path.dirname(path.resolve(configPath)), "current-release.json"), "utf8"));\n const module = await import(pathToFileURL(path.join(path.dirname(current.entrypoint), "lib", "instance-hook.mjs")).href);\n return module.requestInstanceHook(input, configPath, fetcher);\n}\n`;
  fs.writeFileSync(path.join(path.dirname(configPath), "hook-client.mjs"), hookShim, { encoding: "utf8", mode: 0o600 });
  const launcher = launcherPath(configPath);
  const code = `import fs from "node:fs";\nimport path from "node:path";\nimport { spawn } from "node:child_process";\nconst args = process.argv.slice(2);\nconst index = args.indexOf("--config");\nconst configPath = index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : ${JSON.stringify(path.resolve(configPath))};\nconst currentPath = path.join(path.dirname(configPath), "current-release.json");\nconst current = JSON.parse(fs.readFileSync(currentPath, "utf8"));\nconst entrypoint = path.resolve(String(current.entrypoint || ""));\nif (!entrypoint || !fs.existsSync(entrypoint)) throw new Error("Rabi Agent current release is missing.");\nconst forwarded = args.filter((_, i) => i !== index && (index < 0 || i !== index + 1));\nconst child = spawn(process.execPath, [entrypoint, ...(forwarded.length ? forwarded : ["--run"]), "--config", configPath], { cwd: path.dirname(entrypoint), stdio: "inherit", windowsHide: true });\nchild.once("exit", code => { process.exitCode = typeof code === "number" ? code : 1; });\n`;
  fs.writeFileSync(launcher, code, { encoding: "utf8", mode: 0o600 });
  return launcher;
}

function configureCurrentUserStartup(_entrypoint, configPath) {
  const script = path.resolve(writeLauncher(configPath));
  const config = path.resolve(configPath);
  if (process.platform === "win32") {
    const startup = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    fs.mkdirSync(startup, { recursive: true });
    fs.writeFileSync(path.join(startup, "RabiAgent.cmd"), `@echo off\r\n"${process.execPath}" "${script}" --config "${config}"\r\n`, { encoding: "utf8" });
    return;
  }
  if (process.platform === "darwin") {
    const directory = path.join(os.homedir(), "Library", "LaunchAgents");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.rabiroute.agent</string><key>ProgramArguments</key><array><string>${process.execPath}</string><string>${script}</string><string>--config</string><string>${config}</string></array><key>RunAtLoad</key><true/></dict></plist>\n`;
    fs.writeFileSync(path.join(directory, "com.rabiroute.agent.plist"), xml, { encoding: "utf8", mode: 0o600 });
    return;
  }
  const directory = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, "rabi-agent.desktop"), `[Desktop Entry]\nType=Application\nName=Rabi Agent\nExec=${process.execPath} ${script} --config ${config}\nX-GNOME-Autostart-enabled=true\n`, { encoding: "utf8", mode: 0o600 });
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
  if (!["codex-desktop", "dsh"].includes(agentType)) throw new Error("Unsupported Rabi Agent type.");
  if (!nodeCredential || !nodeId || (agentType === "codex-desktop" && !codexThreadId)) throw new Error(`Rabi Agent configuration is incomplete: ${configPath}`);
  return {
    agentType,
    dsh: agentType === "dsh" ? normalizeDshBinding(config.dsh) : undefined,
    schemaVersion: 1,
    agents: config.agents,
    managerUrl,
    nodeCredential,
    nodeId,
    releasePublicKeySha256,
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
    this.taskQueue = Promise.resolve();
    this.taskByThread = new Map();
    this.desktop = new CodexDesktopIpcClient({ onBroadcast: event => this.handleDesktopBroadcast(event) });
  }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeatTimer);
    this.socket?.close(1000, "Rabi Agent stopping");
    this.desktop.close();
  }

  async connect() {
    if (this.stopped || this.connecting || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.connecting = true;
    let socket;
    try {
      await verifyNodeIdentity(this.config, fetch, fs.existsSync(this.configPath) ? this.configPath : undefined);
      if (this.stopped) return;
      socket = new WebSocket(managerWebSocketUrl(this.config.managerUrl));
    } catch (error) {
      // EndpointSession already performs bounded stable-GUID rediscovery and
      // persists only verified identities. Never resurrect the old preverify write.
      this.scheduleReconnect(error);
      return;
    } finally { this.connecting = false; }
    this.socket = socket;
    socket.addEventListener("open", () => this.send({ type: "authenticate", token: this.config.nodeCredential }));
    socket.addEventListener("message", event => this.handleManagerMessage(event.data));
    socket.addEventListener("close", () => {
      this.connected = false;
      clearInterval(this.heartbeatTimer);
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => undefined);
  }

  scheduleReconnect() {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(RECONNECT_MAX_MS, this.retryMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  send(payload) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  handleManagerMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (!message || typeof message !== "object") return;
    if (message.type === "authenticated") {
      this.send({
        type: "hello",
        node: {
          nodeId: this.config.nodeId,
          version: AGENT_VERSION,
          platform: `${process.platform}-${process.arch}`,
          agentTypes: [...new Set(instanceAgents(this.config).map(agent => agent.provider))],
          agents: agentCatalog(this.config),
          allowedWorkspaces: this.config.allowedWorkspaces
        }
      });
      return;
    }
    if (message.type === "connected") {
      this.connected = true;
      this.retryMs = RECONNECT_BASE_MS;
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => this.send({ type: "heartbeat" }), HEARTBEAT_MS);
      this.heartbeatTimer.unref?.();
      if (READY_FILE) {
        try { fs.writeFileSync(READY_FILE, `${this.config.nodeId}\n`, { mode: 0o600 }); } catch { /* parent treats a missing file as an unsuccessful handoff. */ }
        this.send({ type: "updateResult", status: "updated" });
      }
      return;
    }
    if (message.type === "assignTask" && message.task) {
      this.enqueueTask(message.task);
      return;
    }
    if (message.type === "manageAgent") {
      this.taskQueue = this.taskQueue.catch(() => undefined).then(async () => {
        try {
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
            const { manageInstanceAgent } = await import("./runtime/management.mjs");
            const agent = instanceAgents(this.config).find(agent => agent.agentId === message.params?.agentId);
            const initializeNew = !agent && message.params?.agentId === "new-agent" && ["resolve", "create"].includes(message.params?.action) && !message.params?.prompt;
            if (message.operation === "threads" && (!agent || agent.enabled === false) && !initializeNew) throw new Error("The instance Agent is missing or disabled.");
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
            result = await manageInstanceAgent(message.operation, params, { ...this.config, dsh, rootDir: path.dirname(fileURLToPath(import.meta.url)) });
            if (agent && message.operation === "threads" && result.statusCode < 400 && ["resolve", "create"].includes(message.params?.action)) {
              const next = registerManagedSession(this.config, agent.agentId, result.data?.thread?.id);
              if (next !== this.config) {
                writePrivateJson(this.configPath, next);
                this.config = next;
                this.send({ type: "agentCatalog", agents: agentCatalog(next) });
              }
            }
          }
          this.send({ type: "managementResult", requestId: message.requestId, result });
        } catch (error) { this.send({ type: "managementResult", requestId: message.requestId, error: boundedText(error instanceof Error ? error.message : String(error), 1024) }); }
      });
      return;
    }
    if (message.type === "updateAvailable") {
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
    this.taskQueue = this.taskQueue.catch(() => undefined).then(() => this.runTask(task));
  }

  async runTask(task) {
    const taskId = String(task.taskId || "").trim();
    if (this.stateStore.state.tasks[taskId]) return;
    this.send({ type: "ackTask", taskId });
    rememberTask(this.stateStore, taskId, { status: "acknowledged" });
    try {
      if (!this.connected) throw new Error("Manager connection is unavailable; queued task execution was refused.");
      const agent = resolveInstanceAgent(this.config, task);
      const cwd = resolveTaskWorkspace(task.cwd || agent.workspace, { defaultWorkspace: this.config.defaultWorkspace, allowedWorkspaces: this.config.allowedWorkspaces });
      const prompt = String(task.message || "").trim();
      if (!prompt) throw new Error("Rabi Agent task message is empty.");
      // Queued work may outlive a grant revocation. Re-check Manager authority at
      // execution time; connection identity alone does not authorize a host turn.
      const authority = await createManagerClient({ config: this.config, configPath: this.configPath, agentId: agent.agentId }).invoke("GET", "/meta");
      if (!authority.ok || authority.uncertain || authority.identityChanged) throw new Error("Manager no longer authorizes this Agent task; host execution was refused.");
      if (agent.provider === "dsh") {
        await sendDshTask(agent.dsh, prompt);
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
      this.send({ type: "progress", taskId, summary: "Codex Desktop accepted the task. Rabi Agent is waiting for its task state." });
      rememberTask(this.stateStore, taskId, { status: "progress" });
    } catch (error) {
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

  async update(requestedVersion) {
    if (!this.connected) throw new Error("Rabi Agent cannot update while it is disconnected from Manager.");
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
    const readyFile = path.join(os.tmpdir(), `rabi-agent-ready-${process.pid}-${Date.now()}`);
    const child = spawn(process.execPath, [entrypoint, "--run", "--config", this.configPath], {
      cwd: path.dirname(entrypoint),
      env: { ...process.env, RABI_AGENT_READY_FILE: readyFile },
      detached: false,
      stdio: "ignore",
      windowsHide: true
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(readyFile)) {
        try { fs.unlinkSync(readyFile); } catch { /* no follow-up action required */ }
        writeLauncher(this.configPath);
        writeCurrentRelease(this.configPath, entrypoint, releaseDigest(release));
        this.send({ type: "updateResult", status: "updated" });
        this.stop();
        return;
      }
      if (child.exitCode != null) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    try { child.kill(); } catch { /* the new process already failed or exited */ }
    try { fs.unlinkSync(readyFile); } catch { /* no ready file was created */ }
    throw new Error(`Rabi Agent ${release.version} did not connect within 30 seconds; the current version remains active.`);
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
      let size = 0;
      for await (const chunk of process.stdin) {
        size += Buffer.byteLength(chunk);
        if (size > 1024 * 1024) throw new Error("Manager request body exceeds 1 MiB.");
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
    writeCurrentRelease(CONFIG_PATH, fileURLToPath(import.meta.url));
    configureCurrentUserStartup(fileURLToPath(import.meta.url), CONFIG_PATH);
  }
  const runtime = new RabiAgentRuntime(readConfig(CONFIG_PATH), CONFIG_PATH);
  if (!READY_FILE) writeLauncher(CONFIG_PATH);
  runtime.start();
  const stop = () => runtime.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    process.stderr.write(`Rabi Agent failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export const __test = { releaseDigest, readInstalledDigest, installRelease, safeRelativePath, versionAtLeast, managerWebSocketUrl, verifyReleaseManifest, manifestPayload, publicKeySha256, bootstrapConfig, readConfig, authorizedFetch, verifyNodeIdentity, writeLauncher, writeCurrentRelease, RabiAgentRuntime };
