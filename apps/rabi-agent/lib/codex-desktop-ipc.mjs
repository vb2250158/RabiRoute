import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function nonEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function defaultPipePaths() {
  return [...new Set([
    process.env.CODEX_DESKTOP_IPC_PATH?.trim(),
    process.platform === "win32" ? "\\\\.\\pipe\\codex-ipc" : path.join(os.tmpdir(), "codex-ipc", `ipc-${process.getuid?.() ?? "user"}.sock`)
  ].filter(Boolean))];
}

export class CodexDesktopIpcClient {
  constructor({ pipePaths = defaultPipePaths(), requestTimeoutMs = 30_000, onBroadcast } = {}) {
    this.pipePaths = pipePaths;
    this.requestTimeoutMs = requestTimeoutMs;
    this.onBroadcast = onBroadcast;
    this.socket = null;
    this.clientId = "initializing-client";
    this.buffer = Buffer.alloc(0);
    this.nextFrameLength = null;
    this.pending = new Map();
    this.connecting = null;
  }

  async connect() {
    if (this.socket?.writable && this.clientId !== "initializing-client") return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectInternal();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async connectInternal() {
    const errors = [];
    for (const pipePath of this.pipePaths) {
      try {
        await this.connectPath(pipePath);
        const response = await this.request("initialize", { clientType: "rabi-agent" }, 0, true);
        if (response?.resultType !== "success" || !nonEmpty(response?.result?.clientId)) {
          throw new Error(response?.error || "initialize did not return clientId");
        }
        this.clientId = response.result.clientId;
        return;
      } catch (error) {
        this.socket?.destroy();
        this.socket = null;
        errors.push(`${pipePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`Codex Desktop is not ready; Rabi Agent does not start a fallback runtime. ${errors.join("; ")}`);
  }

  connectPath(pipePath) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(pipePath);
      const onError = error => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.nextFrameLength = null;
        socket.on("data", data => this.handleData(data));
        socket.on("error", error => this.rejectPending(error));
        socket.on("close", () => {
          if (this.socket === socket) this.socket = null;
          this.clientId = "initializing-client";
          this.rejectPending(new Error("Codex Desktop IPC connection closed"));
        });
        resolve();
      });
    });
  }

  handleData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    for (;;) {
      if (this.nextFrameLength == null) {
        if (this.buffer.length < 4) return;
        this.nextFrameLength = this.buffer.readUInt32LE(0);
        this.buffer = this.buffer.subarray(4);
      }
      if (this.buffer.length < this.nextFrameLength) return;
      const frame = this.buffer.subarray(0, this.nextFrameLength);
      this.buffer = this.buffer.subarray(this.nextFrameLength);
      this.nextFrameLength = null;
      let message;
      try {
        message = JSON.parse(frame.toString("utf8"));
      } catch {
        continue;
      }
      if (message.type === "client-discovery-request") {
        this.write({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
        continue;
      }
      if (message.type === "broadcast") {
        this.onBroadcast?.(message);
        continue;
      }
      const pending = this.pending.get(message.requestId);
      if (!pending) continue;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }

  write(message) {
    if (!this.socket?.writable) throw new Error("Codex Desktop IPC is not connected");
    this.socket.write(encodeFrame(message));
  }

  request(method, params, version = 1, beforeInitialized = false) {
    const request = async () => {
      if (!beforeInitialized) await this.connect();
      const requestId = randomUUID();
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error(`Codex Desktop IPC request timed out: ${method}`));
        }, this.requestTimeoutMs);
        this.pending.set(requestId, { resolve, reject, timer });
      });
      this.write({ type: "request", requestId, sourceClientId: this.clientId, version, method, params });
      return response;
    };
    return request();
  }

  async startTurn({ threadId, prompt, cwd, model, reasoningEffort = "medium" }) {
    if (!nonEmpty(threadId)) throw new Error("Rabi Agent requires a configured Codex Desktop task owner.");
    const request = {
      threadId,
      clientUserMessageId: randomUUID(),
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd
    };
    if (model) {
      request.model = model;
      request.effort = reasoningEffort;
      request.collaborationMode = { mode: "default", settings: { model, reasoning_effort: reasoningEffort, developer_instructions: "" } };
    }
    const response = await this.request("thread-follower-start-turn", {
      conversationId: threadId,
      turnStart: { request, context: { attachments: [], commentAttachments: [] } }
    }, 2);
    if (response?.resultType !== "success") {
      throw new Error(`Codex Desktop IPC thread-follower-start-turn failed: ${response?.error || "unknown-error"}`);
    }
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
    this.rejectPending(new Error("Codex Desktop IPC client closed"));
  }

  rejectPending(error) {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
