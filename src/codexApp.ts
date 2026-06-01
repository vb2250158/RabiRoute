import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { config } from "./config.js";

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

const statePath = path.join(config.dataDir, "codex-state.json");

type CodexState = {
  monitorThreadId?: string;
  notificationCount?: number;
  lastNotificationAt?: string;
};

function readState(): CodexState {
  if (!fs.existsSync(statePath)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(statePath, "utf8")) as CodexState;
}

function writeState(state: CodexState): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function clearMonitorThreadId(): void {
  const state = readState();
  const { monitorThreadId: _monitorThreadId, ...rest } = state;
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
        name: "qq-agent-gateway",
        title: "QQ Agent Gateway",
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

async function ensureMonitorThread(): Promise<string> {
  const state = readState();
  await connect();

  if (state.monitorThreadId && await canReadThread(state.monitorThreadId)) {
    return state.monitorThreadId;
  }

  const result = await request("thread/start", {
    cwd: config.codexCwd,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    threadSource: "user",
    sessionStartSource: "startup",
    ephemeral: false,
    baseInstructions: null,
    developerInstructions: "这是 QQ/NapCat 消息监听线程。收到提醒后，请读取 C:\\Data\\CottonProject\\qq-agent-gateway\\data 下的 JSONL 消息记录，理解最新 QQ 私聊或群 @ 的上下文，并在 Codex 会话里开始处理。",
    config: null,
    model: null
  }) as { thread?: { id?: string } };

  const threadId = result.thread?.id;
  if (!threadId) {
    throw new Error(`thread/start did not return thread id: ${JSON.stringify(result)}`);
  }

  await request("thread/name/set", {
    threadId,
    name: config.codexThreadName
  });

  writeState({ ...state, monitorThreadId: threadId });
  return threadId;
}

export async function notifyCodex(message: string): Promise<void> {
  notificationQueue = notificationQueue
    .catch(() => undefined)
    .then(() => notifyCodexInternal(message));

  return notificationQueue;
}

async function notifyCodexInternal(message: string): Promise<void> {
  const state = readState();
  const notificationCount = (state.notificationCount ?? 0) + 1;
  const now = new Date();
  const threadName = config.codexThreadName;

  let threadId = await ensureMonitorThread();

  try {
    await startNotificationTurn(threadId, threadName, message);
  } catch (error) {
    if (!isThreadNotFound(error)) {
      throw error;
    }

    clearMonitorThreadId();
    threadId = await ensureMonitorThread();
    await startNotificationTurn(threadId, threadName, message);
  }

  writeState({
    ...state,
    monitorThreadId: threadId,
    notificationCount,
    lastNotificationAt: now.toISOString()
  });
}

async function startNotificationTurn(threadId: string, threadName: string, message: string): Promise<void> {
  await request("thread/name/set", {
    threadId,
    name: threadName
  });

  const idle = waitForThreadIdle(threadId);
  try {
    await request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: [
            message,
            "",
            "这是来自 QQ/NapCat 网关的消息更新提醒。请读取 C:\\Data\\CottonProject\\qq-agent-gateway\\data 下相关 JSONL 的最新记录，理解上下文，并在这个 Codex 会话里开始处理该消息。"
          ].join("\n")
        }
      ],
      cwd: config.codexCwd,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        networkAccess: false,
        writableRoots: []
      },
      effort: "high",
      model: null,
      personality: "friendly"
    });
  } catch (error) {
    idle.catch(() => undefined);
    throw error;
  }

  await idle;
}
