import WebSocket from "ws";

const SHARED_RUNTIME_URL = "ws://127.0.0.1:4510";

function failClosed(method) {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") return { decision: "decline" };
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn", strictAutoReview: true };
  if (method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
  throw new Error(`Remote Agent has no approved handler for Codex server request: ${method}`);
}

export class CodexAppServerClient {
  constructor({ version, onNotification, onExit, requestTimeoutMs } = {}) {
    this.version = version;
    this.onNotification = onNotification;
    this.onExit = onExit;
    this.requestTimeoutMs = requestTimeoutMs ?? 60_000;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
    this.connecting = null;
  }

  async start() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async connect() {
    const socket = new WebSocket(SHARED_RUNTIME_URL);
    this.socket = socket;
    socket.on("message", (data) => this.handleMessage(data.toString()));
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.on("close", () => this.handleExit(socket, new Error("Codex shared Runtime connection closed.")));
    socket.on("error", (error) => this.handleExit(socket, error));
    await this.requestConnected("initialize", {
      clientInfo: { name: "rabiroute-remote-agent", title: "RabiRoute Remote Agent", version: this.version || "unknown" },
      capabilities: { experimentalApi: false, requestAttestation: false }
    });
    this.send({ method: "initialized" });
  }

  async request(method, params) {
    await this.start();
    return this.requestConnected(method, params);
  }

  requestConnected(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Codex shared Runtime request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error(`Codex shared Runtime is unavailable at ${SHARED_RUNTIME_URL}.`);
    this.socket.send(JSON.stringify(message));
  }

  async handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.id != null && message.method) {
      try { this.send({ id: message.id, result: failClosed(message.method) }); }
      catch (error) { this.send({ id: message.id, error: { code: -32000, message: error.message } }); }
      return;
    }
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error != null) pending.reject(new Error(message.error?.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    this.onNotification?.(message);
  }

  handleExit(socket, error) {
    if (this.socket !== socket) return;
    this.socket = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.onExit?.(error);
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSED) socket.terminate();
  }
}
