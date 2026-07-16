import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalCodexWorkspacePath } from "./codexTaskIdentity.js";

export type CodexDesktopSandbox = "read-only" | "workspace-write" | "danger-full-access";

export type CodexDesktopThread = {
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
  rolloutPath: string;
  firstUserMessage: string;
};

type CodexDesktopThreadRow = {
  id?: unknown;
  title?: unknown;
  cwd?: unknown;
  rollout_path?: unknown;
  updated_at?: unknown;
  updated_at_ms?: unknown;
  recency_at?: unknown;
  recency_at_ms?: unknown;
  archived?: unknown;
  first_user_message?: unknown;
};

type IpcResponse = {
  type: "response";
  requestId: string;
  resultType: "success" | "error";
  method?: string;
  result?: unknown;
  error?: string;
};

type IpcMessage = IpcResponse | {
  type: "broadcast";
  method: string;
  params?: unknown;
} | {
  type: "client-discovery-request";
  requestId: string;
};

type PendingRequest = {
  resolve: (response: IpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type CodexDesktopDelivery = {
  threadId: string;
  action: "started" | "steered";
  openedThread: boolean;
  transport: "desktop-ipc";
};

export type CodexDesktopBridgeOptions = {
  pipePaths?: string[];
  requestTimeoutMs?: number;
  loadRetryAttempts?: number;
  loadRetryDelayMs?: number;
  openThread?: (threadId: string) => Promise<void>;
  onBroadcast?: (message: Extract<IpcMessage, { type: "broadcast" }>) => void;
};

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numericTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function rowUpdatedAtMs(row: CodexDesktopThreadRow): number {
  return numericTime(row.recency_at_ms)
    || numericTime(row.updated_at_ms)
    || numericTime(row.recency_at) * 1000
    || numericTime(row.updated_at) * 1000;
}

export function listCodexDesktopThreadsFromRowsForTest(
  rows: CodexDesktopThreadRow[],
  options: { query?: string; limit?: number; offset?: number; allowedWorkspaces?: string[] } = {}
): CodexDesktopThread[] {
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const allowed = new Set((options.allowedWorkspaces ?? []).filter(Boolean).map(canonicalCodexWorkspacePath));
  const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 20) || 20));
  const offset = Math.max(0, Math.floor(options.offset ?? 0) || 0);
  const byId = new Map<string, CodexDesktopThread>();

  for (const row of rows) {
    const id = nonEmptyString(row.id);
    const title = nonEmptyString(row.title) || id;
    const cwd = nonEmptyString(row.cwd);
    const rolloutPath = nonEmptyString(row.rollout_path);
    const updatedAtMs = rowUpdatedAtMs(row);
    if (!id || Number(row.archived ?? 0) !== 0) continue;
    if (query && !title.toLocaleLowerCase().includes(query)) continue;
    if (allowed.size > 0 && (!cwd || !allowed.has(canonicalCodexWorkspacePath(cwd)))) continue;

    const candidate = {
      id,
      title,
      cwd,
      rolloutPath,
      firstUserMessage: nonEmptyString(row.first_user_message),
      updatedAt: new Date(updatedAtMs).toISOString()
    };
    const current = byId.get(id);
    if (!current || Date.parse(candidate.updatedAt) > Date.parse(current.updatedAt)) byId.set(id, candidate);
  }

  return [...byId.values()]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(offset, offset + limit);
}

function codexStateRoots(): string[] {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const sqliteHome = process.env.CODEX_SQLITE_HOME?.trim();
  return [...new Set([sqliteHome, codexHome].filter(Boolean) as string[])];
}

export function findCodexDesktopStateDatabase(): string | null {
  const candidates: Array<{ filePath: string; version: number; modifiedAt: number }> = [];
  for (const root of codexStateRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const match = /^state_(\d+)\.sqlite$/.exec(name);
      if (!match) continue;
      const filePath = path.join(root, name);
      const stat = fs.statSync(filePath);
      candidates.push({ filePath, version: Number(match[1]), modifiedAt: stat.mtimeMs });
    }
  }
  candidates.sort((left, right) => right.version - left.version || right.modifiedAt - left.modifiedAt);
  return candidates[0]?.filePath ?? null;
}

function readDesktopThreadRows(databasePath: string): CodexDesktopThreadRow[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT id, title, cwd, rollout_path, updated_at, updated_at_ms,
             recency_at, recency_at_ms, archived, first_user_message
      FROM threads
      ORDER BY COALESCE(NULLIF(recency_at_ms, 0), NULLIF(updated_at_ms, 0), recency_at * 1000, updated_at * 1000) DESC
      LIMIT 10000
    `).all() as CodexDesktopThreadRow[];
  } finally {
    database.close();
  }
}

export function listCodexDesktopThreads(options: {
  query?: string;
  limit?: number;
  offset?: number;
  allowedWorkspaces?: string[];
  databasePath?: string;
} = {}): CodexDesktopThread[] {
  const databasePath = options.databasePath ?? findCodexDesktopStateDatabase();
  if (!databasePath) return [];
  return listCodexDesktopThreadsFromRowsForTest(readDesktopThreadRows(databasePath), options);
}

export function readCodexDesktopThread(threadId: string, databasePath = findCodexDesktopStateDatabase()): CodexDesktopThread | null {
  if (!databasePath) return null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT id, title, cwd, rollout_path, updated_at, updated_at_ms,
             recency_at, recency_at_ms, archived, first_user_message
      FROM threads WHERE id = ? LIMIT 1
    `).get(threadId) as CodexDesktopThreadRow | undefined;
    return row ? listCodexDesktopThreadsFromRowsForTest([row], { limit: 1 })[0] ?? null : null;
  } finally {
    database.close();
  }
}

export function codexDesktopDeepLinkForTest(threadId: string): string {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

async function openCodexDesktopThread(threadId: string): Promise<void> {
  const deepLink = codexDesktopDeepLinkForTest(threadId);
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [deepLink], {
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  child.unref();
}

function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function responseError(response: IpcResponse, method: string): Error | null {
  return response.resultType === "success"
    ? null
    : new Error(`Codex Desktop IPC ${method} failed: ${response.error || "unknown-error"}`);
}

function isDesktopOwnerLoading(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("no-client-found")
    || text.includes("no rollout found for thread id");
}

function isInactiveTurn(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("SteerTurnInactiveError")
    || text.includes("active turn already ended")
    || text.includes("no active turn to steer")
    || text.includes("not being streamed");
}

export class CodexDesktopBridge {
  private readonly options: Required<Pick<CodexDesktopBridgeOptions,
    "requestTimeoutMs" | "loadRetryAttempts" | "loadRetryDelayMs" | "openThread">> & CodexDesktopBridgeOptions;
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private clientId = "initializing-client";
  private readBuffer = Buffer.alloc(0);
  private nextFrameLength: number | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly activeThreads = new Set<string>();

  constructor(options: CodexDesktopBridgeOptions = {}) {
    this.options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      loadRetryAttempts: Math.max(1, options.loadRetryAttempts ?? 12),
      loadRetryDelayMs: Math.max(1, options.loadRetryDelayMs ?? 500),
      openThread: options.openThread ?? openCodexDesktopThread
    };
  }

  private pipePaths(): string[] {
    if (this.options.pipePaths?.length) return this.options.pipePaths;
    return [...new Set([
      process.env.CODEX_DESKTOP_IPC_PATH?.trim(),
      process.platform === "win32" ? "\\\\.\\pipe\\codex-ipc" : path.join(os.tmpdir(), "codex-ipc", `ipc-${process.getuid?.() ?? "user"}.sock`)
    ].filter(Boolean) as string[])];
  }

  private write(message: unknown): void {
    if (!this.socket?.writable) throw new Error("Codex Desktop IPC is not connected");
    this.socket.write(encodeFrame(message));
  }

  private handleData(data: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, data]);
    for (;;) {
      if (this.nextFrameLength == null) {
        if (this.readBuffer.length < 4) return;
        this.nextFrameLength = this.readBuffer.readUInt32LE(0);
        this.readBuffer = this.readBuffer.subarray(4);
      }
      if (this.readBuffer.length < this.nextFrameLength) return;
      const frame = this.readBuffer.subarray(0, this.nextFrameLength);
      this.readBuffer = this.readBuffer.subarray(this.nextFrameLength);
      this.nextFrameLength = null;
      this.handleMessage(JSON.parse(frame.toString("utf8")) as IpcMessage);
    }
  }

  private handleMessage(message: IpcMessage): void {
    if (message.type === "client-discovery-request") {
      this.write({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: false }
      });
      return;
    }
    if (message.type === "broadcast") {
      if (message.method === "thread-stream-state-changed" && message.params && typeof message.params === "object") {
        const params = message.params as { conversationId?: unknown; threadId?: unknown; change?: unknown };
        const threadId = nonEmptyString(params.conversationId) || nonEmptyString(params.threadId);
        const change = JSON.stringify(params.change ?? params);
        if (threadId && (change.includes('"threadRuntimeStatus":{"type":"active"') || change.includes('"status":"inProgress"'))) {
          this.activeThreads.add(threadId);
        } else if (threadId && (
          change.includes('"threadRuntimeStatus":{"type":"idle"')
          || change.includes('"status":"completed"')
          || change.includes('"status":"failed"')
          || change.includes('"status":"interrupted"')
        )) {
          this.activeThreads.delete(threadId);
        }
      }
      this.options.onBroadcast?.(message);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private async connectPath(pipePath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(pipePath);
      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        this.socket = socket;
        socket.unref();
        this.readBuffer = Buffer.alloc(0);
        this.nextFrameLength = null;
        socket.on("data", (data) => this.handleData(data));
        socket.on("error", (error) => this.rejectPending(error));
        socket.on("close", () => {
          if (this.socket === socket) this.socket = null;
          this.clientId = "initializing-client";
          this.rejectPending(new Error("Codex Desktop IPC connection closed"));
        });
        resolve();
      });
    });
  }

  async connect(): Promise<void> {
    if (this.socket?.writable && this.clientId !== "initializing-client") return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const errors: string[] = [];
      for (const pipePath of this.pipePaths()) {
        try {
          await this.connectPath(pipePath);
          const response = await this.request("initialize", { clientType: "rabiroute" }, 0, true);
          const result = response.result as { clientId?: unknown } | undefined;
          if (response.resultType !== "success" || typeof result?.clientId !== "string") {
            throw new Error(response.error || "initialize did not return clientId");
          }
          this.clientId = result.clientId;
          return;
        } catch (error) {
          this.socket?.destroy();
          this.socket = null;
          errors.push(`${pipePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throw new Error(`Codex Desktop 未就绪。RabiRoute 只连接 Desktop IPC，不会启动备用 Runtime。${errors.length ? ` ${errors.join("; ")}` : ""}`);
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async request(method: string, params: unknown, version = 1, beforeInitialized = false): Promise<IpcResponse> {
    if (!beforeInitialized) await this.connect();
    const requestId = randomUUID();
    const response = new Promise<IpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Codex Desktop IPC request timed out: ${method}`));
      }, this.options.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
    this.write({
      type: "request",
      requestId,
      sourceClientId: this.clientId,
      version,
      method,
      params
    });
    return response;
  }

  async isReady(): Promise<boolean> {
    try {
      await this.connect();
      return true;
    } catch {
      return false;
    }
  }

  isThreadActive(threadId: string): boolean {
    return this.activeThreads.has(threadId);
  }

  private async steer(params: { threadId: string; prompt: string; cwd: string }): Promise<void> {
    const response = await this.request("thread-follower-steer-turn", {
      conversationId: params.threadId,
      input: [{ type: "text", text: params.prompt, text_elements: [] }],
      attachments: [],
      restoreMessage: {
        id: randomUUID(),
        text: params.prompt,
        context: {
          prompt: params.prompt,
          addedFiles: [],
          fileAttachments: [],
          imageAttachments: [],
          workspaceRoots: [params.cwd]
        },
        cwd: params.cwd,
        createdAt: Date.now()
      }
    });
    const error = responseError(response, "thread-follower-steer-turn");
    if (error) throw error;
  }

  private async start(params: { threadId: string; prompt: string }): Promise<void> {
    const response = await this.request("thread-follower-start-turn", {
      conversationId: params.threadId,
      turnStartParams: {
        input: [{ type: "text", text: params.prompt, text_elements: [] }],
        attachments: [],
        commentAttachments: []
      }
    });
    const error = responseError(response, "thread-follower-start-turn");
    if (error) throw error;
  }

  private async deliverToOwner(params: {
    threadId: string;
    prompt: string;
    cwd: string;
    sandbox: CodexDesktopSandbox;
  }): Promise<"started" | "steered"> {
    try {
      await this.steer(params);
      return "steered";
    } catch (error) {
      if (!isInactiveTurn(error)) throw error;
    }
    await this.start(params);
    return "started";
  }

  async deliver(params: {
    threadId: string;
    prompt: string;
    cwd: string;
    sandbox: CodexDesktopSandbox;
  }): Promise<CodexDesktopDelivery> {
    let openedThread = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < this.options.loadRetryAttempts; attempt += 1) {
      try {
        const action = await this.deliverToOwner(params);
        this.activeThreads.add(params.threadId);
        return { threadId: params.threadId, action, openedThread, transport: "desktop-ipc" };
      } catch (error) {
        lastError = error;
        if (!isDesktopOwnerLoading(error)) throw error;
        if (!openedThread) {
          openedThread = true;
          await this.options.openThread(params.threadId);
        }
        if (attempt + 1 < this.options.loadRetryAttempts) await wait(this.options.loadRetryDelayMs);
      }
    }
    throw new Error(`Codex Desktop 已打开任务 ${params.threadId}，但 Desktop owner 没有完成加载；消息未投递，也没有启动备用 Runtime。原始错误：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.clientId = "initializing-client";
    this.rejectPending(new Error("Codex Desktop bridge closed"));
  }
}
