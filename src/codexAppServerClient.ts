import WebSocket from "ws";
import { CODEX_SHARED_RUNTIME_URL } from "./codexSharedRuntime.js";

type RequestId = number | string;
type Message = { id?: RequestId; method?: string; params?: unknown; result?: unknown; error?: unknown };
type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer: NodeJS.Timeout };

export type CodexAppServerClientOptions = {
  requestTimeoutMs?: number;
  clientVersion?: string;
  onNotification?: (message: Message) => void;
  onServerRequest?: (message: Required<Pick<Message, "id" | "method">> & Pick<Message, "params">) => Promise<unknown>;
  onExit?: (error: Error) => void;
};

export function failClosedCodexServerRequestForTest(method: string): unknown {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") return { decision: "decline" };
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn", strictAutoReview: true };
  if (method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
  throw new Error(`RabiRoute has no approved handler for Codex server request: ${method}`);
}

export class CodexAppServerClient {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<RequestId, Pending>();

  constructor(private readonly options: CodexAppServerClientOptions = {}) {}

  async start(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectInternal().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.start();
    const id = this.nextId++;
    const timeoutMs = this.options.requestTimeoutMs ?? (method === "turn/start" || method === "turn/steer" ? 180_000 : 60_000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Codex shared Runtime request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSED) socket.terminate();
    this.rejectPending(new Error("Codex shared Runtime client closed."));
  }

  private async connectInternal(): Promise<void> {
    const socket = new WebSocket(CODEX_SHARED_RUNTIME_URL);
    this.socket = socket;
    socket.on("message", (data) => this.handleMessage(data.toString()));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.on("close", () => this.handleClose(socket, new Error("Codex shared Runtime connection closed.")));
    socket.on("error", (error) => this.handleClose(socket, error));
    await this.requestConnected("initialize", {
      clientInfo: { name: "rabiroute", title: "RabiRoute", version: this.options.clientVersion ?? "unknown" },
      capabilities: { experimentalApi: false, requestAttestation: false }
    });
    this.send({ method: "initialized" });
  }

  private requestConnected(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Codex shared Runtime request timed out: ${method}`));
      }, this.options.requestTimeoutMs ?? 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private send(message: Message): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error(`Codex shared Runtime is unavailable at ${CODEX_SHARED_RUNTIME_URL}.`);
    this.socket.send(JSON.stringify(message));
  }

  private handleMessage(raw: string): void {
    let message: Message;
    try { message = JSON.parse(raw) as Message; } catch { return; }
    if (message.id != null && message.method) {
      void this.handleServerRequest(message as Required<Pick<Message, "id" | "method">> & Pick<Message, "params">);
      return;
    }
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error != null) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    this.options.onNotification?.(message);
  }

  private async handleServerRequest(message: Required<Pick<Message, "id" | "method">> & Pick<Message, "params">): Promise<void> {
    try {
      const result = this.options.onServerRequest
        ? await this.options.onServerRequest(message)
        : failClosedCodexServerRequestForTest(message.method);
      this.send({ id: message.id, result });
    } catch (error) {
      this.send({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private handleClose(socket: WebSocket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.rejectPending(error);
    this.options.onExit?.(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
