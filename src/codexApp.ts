import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { config } from "./config.js";
import { reportAgentState } from "./agentAdapters/stateReporter.js";

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: unknown;
  method?: string;
  params?: unknown;
};

type JsonRpcPending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type ThreadStatusChangedParams = {
  threadId?: string;
  status?: {
    type?: string;
  };
};

type ThreadStatusWaiter = {
  threadId: string;
  resolve: () => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
};

let socket: WebSocket | null = null;
let nextId = 1;
let connecting: Promise<WebSocket> | null = null;
const pending = new Map<number, JsonRpcPending>();
const threadStatusWaiters: ThreadStatusWaiter[] = [];
let notificationQueue: Promise<void> = Promise.resolve();
let memoryState: CodexState = {};

function explicitCodexModel(): string | undefined {
  const envModel = process.env.RABIROUTE_CODEX_MODEL?.trim() || process.env.CODEX_MODEL?.trim();
  if (envModel) return envModel;
  return undefined;
}

function codexModelField(): string {
  return config.agentModel || explicitCodexModel() || "gpt-5.5";
}

type CodexState = {
  monitorThreadId?: string;
  monitorThreadName?: string;
  monitorThreadUpdatedAt?: string;
  monitorThreadSource?: string;
  lastAutoDiscoveryAt?: string;
  notificationCount?: number;
  lastNotificationAt?: string;
  lastNotificationError?: string;
  lastNotificationErrorAt?: string;
};

type CodexSessionIndexRecord = {
  id?: unknown;
  thread_name?: unknown;
  updated_at?: unknown;
};

type DiscoveredMonitorThread = {
  id: string;
  threadName: string;
  updatedAt: string;
  source: string;
};

export type CodexAppMonitorThread = {
  id: string;
  threadName: string;
  updatedAt: string;
  source: string;
};

function readState(): CodexState {
  return memoryState;
}

function writeState(state: CodexState): void {
  memoryState = state;
  reportAgentState("codex", state);
}

function clearMonitorThreadId(): void {
  const state = readState();
  const {
    monitorThreadId: _monitorThreadId,
    monitorThreadUpdatedAt: _monitorThreadUpdatedAt,
    monitorThreadSource: _monitorThreadSource,
    ...rest
  } = state;
  writeState(rest);
}

function isThreadNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes("thread not found");
}

function codexBin(): string {
  return path.resolve(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
}

function handleNotification(msg: JsonRpcResponse): void {
  if (msg.method !== "thread/status/changed") {
    return;
  }

  const params = msg.params as ThreadStatusChangedParams;
  const threadId = params.threadId;
  const status = params.status?.type;
  if (!threadId || (status !== "idle" && status !== "systemError")) {
    return;
  }

  for (let i = threadStatusWaiters.length - 1; i >= 0; i--) {
    const waiter = threadStatusWaiters[i];
    if (waiter.threadId !== threadId) {
      continue;
    }

    threadStatusWaiters.splice(i, 1);
    clearTimeout(waiter.timer);
    if (status === "systemError") {
      waiter.reject(new Error(`Codex thread entered systemError: ${threadId}`));
    } else {
      waiter.resolve();
    }
  }
}

function waitForThreadIdle(threadId: string, timeoutMs = 180000): Promise<void> {
  return new Promise((resolve, reject) => {
    const waiter: ThreadStatusWaiter = {
      threadId,
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = threadStatusWaiters.indexOf(waiter);
        if (index >= 0) {
          threadStatusWaiters.splice(index, 1);
        }
        reject(new Error(`Timed out waiting for Codex thread to become idle: ${threadId}`));
      }, timeoutMs)
    };

    threadStatusWaiters.push(waiter);
  });
}

async function ensureAppServer(): Promise<void> {
  try {
    const url = new URL(config.codexAppServerUrl);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      return;
    }

    const healthUrl = `http://${url.hostname}:${url.port}/healthz`;
    const response = await fetch(healthUrl);
    if (response.ok) {
      return;
    }
  } catch {
    // Start a local app-server if the health check fails.
  }

  const url = new URL(config.codexAppServerUrl);
  if (url.protocol !== "ws:") {
    throw new Error(`Cannot auto-start non-ws app-server: ${config.codexAppServerUrl}`);
  }

  const out = path.join(config.dataDir, "codex-app-server.out.log");
  const err = path.join(config.dataDir, "codex-app-server.err.log");
  fs.mkdirSync(config.dataDir, { recursive: true });

  const child = spawn(codexBin(), ["app-server", "--listen", config.codexAppServerUrl], {
    cwd: config.codexCwd,
    detached: true,
    shell: process.platform === "win32",
    stdio: ["ignore", fs.openSync(out, "a"), fs.openSync(err, "a")]
  });
  child.unref();

  await new Promise((resolve) => setTimeout(resolve, 3000));
}

async function connect(): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) {
    return socket;
  }

  if (connecting) {
    return connecting;
  }

  connecting = (async () => {
    await ensureAppServer();
    const ws = new WebSocket(config.codexAppServerUrl);
    socket = ws;

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as JsonRpcResponse;
      if (typeof msg.id !== "number") {
        handleNotification(msg);
        return;
      }

      const item = pending.get(msg.id);
      if (!item) {
        return;
      }

      pending.delete(msg.id);
      if (msg.error) {
        item.reject(new Error(JSON.stringify(msg.error)));
      } else {
        item.resolve(msg.result);
      }
    });

    ws.on("close", () => {
      socket = null;
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    await request("initialize", {
      clientInfo: {
        name: "rabiroute",
        title: "RabiRoute",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    return ws;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

async function request(method: string, params: unknown): Promise<unknown> {
  const ws = socket?.readyState === WebSocket.OPEN ? socket : await connect();
  const id = nextId++;
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) {
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }
    }, 20000);
  });
}

async function canReadThread(threadId: string): Promise<boolean> {
  try {
    await request("thread/read", { threadId });
    return true;
  } catch {
    return false;
  }
}

function sessionIndexPath(): string {
  return path.join(os.homedir(), ".codex", "session_index.jsonl");
}

function findThreadByName(threadName: string): DiscoveredMonitorThread | null {
  const indexPath = sessionIndexPath();
  if (!fs.existsSync(indexPath)) {
    return null;
  }

  const latestById = new Map<string, DiscoveredMonitorThread>();
  for (const line of fs.readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as CodexSessionIndexRecord;
      if (typeof parsed.id !== "string" || typeof parsed.thread_name !== "string" || typeof parsed.updated_at !== "string") {
        continue;
      }

      const record = {
        id: parsed.id,
        threadName: parsed.thread_name,
        updatedAt: parsed.updated_at,
        source: indexPath
      };
      const existing = latestById.get(record.id);
      if (!existing || Date.parse(record.updatedAt) > Date.parse(existing.updatedAt)) {
        latestById.set(record.id, record);
      }
    } catch {
      // Ignore malformed JSONL lines.
    }
  }

  return [...latestById.values()]
    .filter((record) => record.threadName === threadName)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] ?? null;
}

function bindThread(state: CodexState, thread: DiscoveredMonitorThread): void {
  writeState({
    ...state,
    monitorThreadId: thread.id,
    monitorThreadName: thread.threadName,
    monitorThreadUpdatedAt: thread.updatedAt,
    monitorThreadSource: thread.source,
    lastAutoDiscoveryAt: new Date().toISOString()
  });
}

function duplicateThreadRefusalError(thread: DiscoveredMonitorThread): Error {
  return new Error([
    `Codex thread named "${thread.threadName}" already exists in ${thread.source} as ${thread.id},`,
    "but the app-server channel cannot read it. Refusing to auto-create another thread with the same name."
  ].join(" "));
}

async function ensureMonitorThread(forceCreate = false): Promise<string> {
  const state = readState();
  const threadName = config.codexThreadName;
  await connect();

  const existingThread = forceCreate ? null : findThreadByName(threadName);
  if (existingThread) {
    if (await canReadThread(existingThread.id)) {
      bindThread(state, existingThread);
      return existingThread.id;
    }

    throw duplicateThreadRefusalError(existingThread);
  }

  if (!forceCreate && state.monitorThreadId && (!state.monitorThreadName || state.monitorThreadName === threadName) && await canReadThread(state.monitorThreadId)) {
    return state.monitorThreadId;
  }

  const threadStartParams: Record<string, unknown> = {
    cwd: config.codexCwd,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    threadSource: "user",
    sessionStartSource: "startup",
    ephemeral: false,
    developerInstructions: `这是 QQ/NapCat 消息监听线程。收到提醒后，请读取 ${config.memoryDataDir} 下的 JSONL 消息记录，理解最新 QQ 私聊或群 @ 的上下文，并在 Codex 会话里开始处理。`,
  };
  threadStartParams.model = codexModelField();

  const result = await request("thread/start", threadStartParams) as { thread?: { id?: string } };

  const threadId = result.thread?.id;
  if (!threadId) {
    throw new Error(`thread/start did not return thread id: ${JSON.stringify(result)}`);
  }

  await request("thread/name/set", {
    threadId,
    name: threadName
  });

  writeState({
    ...state,
    monitorThreadId: threadId,
    monitorThreadName: threadName,
    monitorThreadUpdatedAt: new Date().toISOString(),
    monitorThreadSource: "codex app-server",
    lastAutoDiscoveryAt: new Date().toISOString()
  });
  return threadId;
}

export async function createCodexAppMonitorThread(forceCreate = false): Promise<CodexAppMonitorThread> {
  const threadId = await ensureMonitorThread(forceCreate);
  const state = readState();
  return {
    id: threadId,
    threadName: state.monitorThreadName ?? config.codexThreadName,
    updatedAt: state.monitorThreadUpdatedAt ?? new Date().toISOString(),
    source: state.monitorThreadSource ?? "codex app-server"
  };
}

export type NotifyCodexOptions = {
  forceCreateUnreadableThread?: boolean;
};

function isUnreadableDuplicateThreadError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("app-server channel cannot read it");
}

export async function notifyCodex(message: string, options: NotifyCodexOptions = {}): Promise<void> {
  notificationQueue = notificationQueue
    .catch(() => undefined)
    .then(() => notifyCodexInternal(message, options));

  return notificationQueue;
}

async function notifyCodexInternal(message: string, options: NotifyCodexOptions): Promise<void> {
  const state = readState();
  const notificationCount = (state.notificationCount ?? 0) + 1;
  const now = new Date();
  const threadName = config.codexThreadName;

  let threadId: string;
  try {
    threadId = await ensureMonitorThread();
  } catch (error) {
    if (!options.forceCreateUnreadableThread || !isUnreadableDuplicateThreadError(error)) {
      throw error;
    }

    threadId = await ensureMonitorThread(true);
  }

  try {
    await startNotificationTurn(threadId, threadName, message);
  } catch (error) {
    if (!isThreadNotFound(error)) {
      throw error;
    }

    const indexedThread = findThreadByName(threadName);
    if (indexedThread) {
      throw duplicateThreadRefusalError(indexedThread);
    }

    clearMonitorThreadId();
    threadId = await ensureMonitorThread(true);
    await startNotificationTurn(threadId, threadName, message);
  }

  writeState({
    ...state,
    monitorThreadId: threadId,
    monitorThreadName: threadName,
    notificationCount,
    lastNotificationAt: now.toISOString(),
    lastNotificationError: "",
    lastNotificationErrorAt: ""
  });
}

async function startNotificationTurn(threadId: string, threadName: string, message: string): Promise<void> {
  await request("thread/name/set", {
    threadId,
    name: threadName
  });

  const idle = process.env.CODEX_APP_NOTIFY_WAIT_FOR_IDLE === "1"
    ? waitForThreadIdle(threadId)
    : undefined;
  try {
    const turnStartParams: Record<string, unknown> = {
      threadId,
      input: [
        {
          type: "text",
          text: [
            message,
            "",
            `这是来自 QQ/NapCat 网关的消息更新提醒。请读取 ${config.memoryDataDir} 下相关 JSONL 的最新记录，理解上下文，并在这个 Codex 会话里开始处理该消息。`
          ].join("\n")
        }
      ],
      cwd: config.codexCwd,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess"
      },
      effort: "high",
      personality: "friendly"
    };
    turnStartParams.model = codexModelField();

    await request("turn/start", turnStartParams);
  } catch (error) {
    idle?.catch(() => undefined);
    throw error;
  }

  await idle;
}
