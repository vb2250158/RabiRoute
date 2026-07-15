import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DEFAULT_OVERLOAD_RETRY_LIMIT = 3;
const DEFAULT_OVERLOAD_RETRY_BASE_MS = 250;

function resolvePinnedCodexEntrypoint() {
  try {
    return require.resolve("@openai/codex/bin/codex.js");
  } catch {
    return "";
  }
}

class CodexAppServerRpcError extends Error {
  constructor(error) {
    super(typeof error?.message === "string" ? error.message : JSON.stringify(error));
    this.name = "CodexAppServerRpcError";
    this.code = typeof error?.code === "number" ? error.code : undefined;
    this.data = error?.data;
  }
}

function failClosedServerRequest(method) {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    return { decision: "decline" };
  }
  if (method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn", strictAutoReview: true };
  }
  if (method === "mcpServer/elicitation/request") {
    return { action: "decline", content: null, _meta: null };
  }
  throw new Error(`Remote Agent has no approved handler for Codex server request: ${method}`);
}

export class CodexAppServerClient {
  constructor({ cwd, logDir, version, onNotification, onExit, requestTimeoutMs, overloadRetryLimit, overloadRetryBaseMs, entrypoint }) {
    this.cwd = cwd;
    this.logDir = logDir;
    this.version = version;
    this.onNotification = onNotification;
    this.onExit = onExit;
    this.requestTimeoutMs = requestTimeoutMs;
    this.overloadRetryLimit = overloadRetryLimit ?? DEFAULT_OVERLOAD_RETRY_LIMIT;
    this.overloadRetryBaseMs = overloadRetryBaseMs ?? DEFAULT_OVERLOAD_RETRY_BASE_MS;
    this.entrypoint = entrypoint;
    this.child = null;
    this.starting = null;
    this.stderrLog = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    if (this.starting) return this.starting;
    if (this.child && !this.child.killed && this.child.exitCode == null) return;
    this.starting = this.startInternal();
    try {
      await this.starting;
    } catch (error) {
      this.stopCurrentChild();
      throw error;
    } finally {
      this.starting = null;
    }
  }

  async request(method, params) {
    await this.start();
    return this.requestConnectedWithOverloadRetry(method, params);
  }

  close() {
    this.stopCurrentChild();
    this.rejectPending(new Error("Codex app-server client closed."));
  }

  async startInternal() {
    const codexEntrypoint = this.entrypoint || resolvePinnedCodexEntrypoint();
    if (!codexEntrypoint || !fs.existsSync(codexEntrypoint)) {
      throw new Error("Pinned @openai/codex runtime is missing. Run npm install in the bridge folder.");
    }
    fs.mkdirSync(this.logDir, { recursive: true });
    this.stderrLog = fs.createWriteStream(path.join(this.logDir, "codex-app-server.stderr.log"), { flags: "a" });
    const child = spawn(process.execPath, [codexEntrypoint, "app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stderr.pipe(this.stderrLog, { end: false });
    child.stdin.once("error", (error) => this.handleExit(child, error));
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (this.child === child) this.handleLine(child, line);
    });
    child.once("error", (error) => this.handleExit(child, error));
    child.once("exit", (code, signal) => {
      this.handleExit(child, new Error(`Codex app-server exited (code=${String(code)}, signal=${String(signal)}).`));
    });

    await this.requestConnectedWithOverloadRetry("initialize", {
      clientInfo: {
        name: "rabiroute-remote-agent",
        title: "RabiRoute Remote Agent",
        version: this.version
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false
      }
    });
    this.writeMessage({ method: "initialized" });
  }

  requestConnected(method, params) {
    const child = this.child;
    if (!child || child.killed || child.exitCode != null) {
      return Promise.reject(new Error("Codex app-server is not running."));
    }
    const id = this.nextId++;
    const timeoutMs = this.requestTimeoutMs || (
      method === "thread/start" || method === "turn/start" || method === "turn/steer" ? 180_000 : 60_000
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeMessage({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async requestConnectedWithOverloadRetry(method, params) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestConnected(method, params);
      } catch (error) {
        if (!(error instanceof CodexAppServerRpcError) || error.code !== -32001 || attempt >= this.overloadRetryLimit) {
          throw error;
        }
        const exponentialMs = this.overloadRetryBaseMs * (2 ** attempt);
        const jitteredMs = Math.max(0, Math.round(exponentialMs * (0.5 + Math.random())));
        await new Promise((resolve) => setTimeout(resolve, jitteredMs));
      }
    }
  }

  writeMessage(message) {
    const child = this.child;
    if (!child) throw new Error("Codex app-server is not running.");
    this.writeMessageToChild(child, message);
  }

  writeMessageToChild(child, message) {
    if (this.child !== child) throw new Error("Codex app-server request belongs to a stale process.");
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) throw new Error("Codex app-server stdin is not writable.");
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(child, line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.stderrLog?.write(`[rabiroute] non-JSON stdout: ${trimmed}\n`);
      return;
    }
    if (message.id != null && message.method) {
      void this.handleServerRequest(child, message).catch((error) => this.logError("server request handling failed", error));
      return;
    }
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error != null) pending.reject(new CodexAppServerRpcError(message.error));
      else pending.resolve(message.result);
      return;
    }
    this.onNotification?.(message);
  }

  async handleServerRequest(child, message) {
    try {
      this.writeMessageToChild(child, { id: message.id, result: failClosedServerRequest(message.method) });
    } catch (error) {
      try {
        this.writeMessageToChild(child, {
          id: message.id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) }
        });
      } catch (responseError) {
        this.logError("failed to reject Codex server request", responseError);
      }
    }
  }

  handleExit(child, error) {
    if (this.child !== child) return;
    this.child = null;
    child.stderr.unpipe(this.stderrLog ?? undefined);
    this.stderrLog?.end();
    this.stderrLog = null;
    if (!child.killed && child.exitCode == null) child.kill();
    this.rejectPending(error);
    try {
      this.onExit?.(error);
    } catch (callbackError) {
      this.logError("app-server exit callback failed", callbackError);
    }
  }

  stopCurrentChild() {
    const child = this.child;
    this.child = null;
    if (child) {
      child.stderr.unpipe(this.stderrLog ?? undefined);
      if (!child.killed) child.kill();
    }
    this.stderrLog?.end();
    this.stderrLog = null;
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  logError(context, error) {
    this.stderrLog?.write(`[rabiroute] ${context}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
