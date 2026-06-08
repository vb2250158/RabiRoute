import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { notifyCodex } from "./codexApp.js";

type IpcResponse = {
  type: "response";
  requestId: string;
  resultType: "success" | "error";
  method?: string;
  result?: unknown;
  error?: string;
};

type IpcMessage =
  | IpcResponse
  | {
      type: "broadcast";
      method: string;
      params?: {
        conversationId?: string;
        change?: unknown;
      };
    }
  | {
      type: "client-discovery-request";
      requestId: string;
    };

type IpcPending = {
  resolve: (value: IpcResponse) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
};

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

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function getCodexIpcPaths(): string[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const socketName = uid == null ? "ipc.sock" : `ipc-${uid}.sock`;
  const configuredPath = process.env.CODEX_DESKTOP_IPC_PATH?.trim();

  if (process.platform === "win32") {
    return unique([configuredPath, "\\\\.\\pipe\\codex-ipc"].filter(Boolean) as string[]);
  }

  return unique([
    configuredPath,
    path.join(os.tmpdir(), "codex-ipc", socketName),
    path.join("/tmp", "codex-ipc", socketName),
  ].filter(Boolean) as string[]);
}

const statePath = path.join(config.dataDir, "codex-state.json");
const pending = new Map<string, IpcPending>();

let socket: net.Socket | null = null;
let connecting: Promise<net.Socket> | null = null;
let clientId = "initializing-client";
let readBuffer = Buffer.alloc(0);
let nextFrameLength: number | null = null;
let notificationQueue: Promise<void> = Promise.resolve();
let monitorThreadActive = false;
let lastStartedTurnAt = 0;
let pendingMessages: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let flushWaiters: Array<{
  resolve: () => void;
  reject: (reason: unknown) => void;
}> = [];

const recentStartSteerWindowMs = 10 * 60 * 1000;
const notificationBatchDelayMs = 2500;

function readState(): CodexState {
  if (!fs.existsSync(statePath)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, "")) as CodexState;
}

function writeState(state: CodexState): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function sessionIndexPath(): string {
  return path.join(os.homedir(), ".codex", "session_index.jsonl");
}

function readLatestSessionThreads(): DiscoveredMonitorThread[] {
  const indexPath = sessionIndexPath();
  if (!fs.existsSync(indexPath)) {
    return [];
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

  return [...latestById.values()];
}

function discoverMonitorThread(): DiscoveredMonitorThread | null {
  const targetName = config.codexThreadName.trim();
  const records = readLatestSessionThreads()
    .filter((item) => item.threadName === targetName)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));

  return records[0] ?? null;
}

function stateStillPointsToTargetThread(state: CodexState): boolean {
  const targetName = config.codexThreadName.trim();
  if (!state.monitorThreadId || state.monitorThreadName !== targetName) {
    return false;
  }

  const currentRecord = readLatestSessionThreads().find((item) => item.id === state.monitorThreadId);
  return !currentRecord || currentRecord.threadName === targetName;
}

function applyDiscoveredThread(state: CodexState, discovered: DiscoveredMonitorThread): CodexState {
  return {
    ...state,
    monitorThreadId: discovered.id,
    monitorThreadName: discovered.threadName,
    monitorThreadUpdatedAt: discovered.updatedAt,
    monitorThreadSource: discovered.source,
    lastAutoDiscoveryAt: new Date().toISOString()
  };
}

function resolveMonitorThread(state: CodexState, forceRefresh: boolean): CodexState {
  if (!forceRefresh && stateStillPointsToTargetThread(state)) {
    return state;
  }

  const discovered = discoverMonitorThread();
  if (!discovered) {
    if (state.monitorThreadId) {
      const nextState = {
        ...state,
        monitorThreadId: undefined,
        monitorThreadUpdatedAt: undefined,
        monitorThreadSource: sessionIndexPath(),
        lastAutoDiscoveryAt: new Date().toISOString(),
        lastNotificationError: `No Codex thread named "${config.codexThreadName}" was found in ${sessionIndexPath()}. Previous binding "${String(state.monitorThreadName ?? state.monitorThreadId)}" was cleared.`,
        lastNotificationErrorAt: new Date().toISOString()
      };
      writeState(nextState);
      return nextState;
    }
    return state;
  }

  const discoveredIsNewer = !state.monitorThreadUpdatedAt || Date.parse(discovered.updatedAt) > Date.parse(state.monitorThreadUpdatedAt);
  const shouldApply = forceRefresh
    || !state.monitorThreadId
    || state.monitorThreadName !== config.codexThreadName
    || discoveredIsNewer;

  if (!shouldApply) {
    return state;
  }

  const nextState = applyDiscoveredThread(state, discovered);
  writeState(nextState);
  return nextState;
}

function resolveConfiguredMonitorThread(state: CodexState, forceRefresh: boolean): CodexState {
  const resolvedState = resolveMonitorThread(state, forceRefresh);
  if (!resolvedState.monitorThreadId || !resolvedState.monitorThreadName || resolvedState.monitorThreadName === config.codexThreadName) {
    return resolvedState;
  }

  const refreshedState = resolveMonitorThread(readState(), true);
  if (!refreshedState.monitorThreadId || !refreshedState.monitorThreadName || refreshedState.monitorThreadName === config.codexThreadName) {
    return refreshedState;
  }

  const nextState = {
    ...refreshedState,
    monitorThreadId: undefined,
    monitorThreadUpdatedAt: undefined,
    monitorThreadSource: sessionIndexPath(),
    lastAutoDiscoveryAt: new Date().toISOString(),
    lastNotificationError: `No Codex thread named "${config.codexThreadName}" was found in ${sessionIndexPath()}. Previous binding "${refreshedState.monitorThreadName}" was cleared.`,
    lastNotificationErrorAt: new Date().toISOString()
  };
  writeState(nextState);
  return nextState;
}

function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function send(message: unknown): void {
  if (!socket?.writable) {
    throw new Error("Codex Desktop IPC is not connected");
  }

  socket.write(encodeFrame(message));
}

function handleData(data: Buffer): void {
  readBuffer = Buffer.concat([readBuffer, data]);

  for (;;) {
    if (nextFrameLength == null) {
      if (readBuffer.length < 4) {
        return;
      }

      nextFrameLength = readBuffer.readUInt32LE(0);
      readBuffer = readBuffer.subarray(4);
    }

    if (readBuffer.length < nextFrameLength) {
      return;
    }

    const frame = readBuffer.subarray(0, nextFrameLength);
    readBuffer = readBuffer.subarray(nextFrameLength);
    nextFrameLength = null;
    handleMessage(JSON.parse(frame.toString("utf8")) as IpcMessage);
  }
}

function handleMessage(message: IpcMessage): void {
  if (message.type === "client-discovery-request") {
    send({
      type: "client-discovery-response",
      requestId: message.requestId,
      response: {
        canHandle: false
      }
    });
    return;
  }

  if (message.type === "broadcast") {
    updateMonitorThreadActivity(message);
    return;
  }

  if (message.type !== "response") {
    return;
  }

  const item = pending.get(message.requestId);
  if (!item) {
    return;
  }

  pending.delete(message.requestId);
  clearTimeout(item.timer);
  item.resolve(message);
}

function updateMonitorThreadActivity(message: Extract<IpcMessage, { type: "broadcast" }>): void {
  if (message.method !== "thread-stream-state-changed") {
    return;
  }

  const state = readState();
  if (!state.monitorThreadId || message.params?.conversationId !== state.monitorThreadId) {
    return;
  }

  const changeText = JSON.stringify(message.params.change);
  if (changeText.includes("\"threadRuntimeStatus\":{\"type\":\"active\"") || changeText.includes("\"status\":\"inProgress\"")) {
    monitorThreadActive = true;
    return;
  }

  if (changeText.includes("\"threadRuntimeStatus\":{\"type\":\"idle\"") || changeText.includes("\"status\":\"completed\"") || changeText.includes("\"status\":\"failed\"") || changeText.includes("\"status\":\"interrupted\"")) {
    monitorThreadActive = false;
  }
}

function connect(): Promise<net.Socket> {
  if (socket?.writable && clientId !== "initializing-client") {
    return Promise.resolve(socket);
  }

  if (connecting) {
    return connecting;
  }

  connecting = new Promise((resolve, reject) => {
    const pipePaths = getCodexIpcPaths();
    const errors: string[] = [];
    let index = 0;
    let next: net.Socket | null = null;

    const connectNext = () => {
      const pipePath = pipePaths[index++];
      if (!pipePath) {
        socket = null;
        reject(new Error(`Codex Desktop IPC connection failed. Tried: ${pipePaths.join(", ")}. Errors: ${errors.join("; ")}`));
        return;
      }

      next = net.connect(pipePath);
      const onError = (error: NodeJS.ErrnoException) => {
        next?.destroy();
        errors.push(`${pipePath}: ${error.code ?? error.message}`);
        connectNext();
      };

      next.once("error", onError);
      next.once("connect", async () => {
        next?.off("error", onError);
        if (!next) {
          reject(new Error("Codex Desktop IPC socket disappeared during connect"));
          return;
        }

        const connected = next;
        socket = connected;
        readBuffer = Buffer.alloc(0);
        nextFrameLength = null;
        clientId = "initializing-client";

        connected.on("data", handleData);
        connected.on("close", () => {
          socket = null;
          clientId = "initializing-client";
          for (const [id, item] of pending) {
            pending.delete(id);
            clearTimeout(item.timer);
            item.reject(new Error("Codex Desktop IPC connection closed"));
          }
        });

        try {
          const response = await request("initialize", { clientType: "rabiroute" }, 0, true);
          if (response.resultType !== "success" || !response.result || typeof response.result !== "object" || !("clientId" in response.result)) {
            throw new Error(`Codex Desktop IPC initialize failed: ${JSON.stringify(response)}`);
          }

          clientId = String((response.result as { clientId: unknown }).clientId);
          resolve(connected);
        } catch (error) {
          connected.destroy();
          reject(error);
        }
      });
    };

    connectNext();
  });

  return connecting.finally(() => {
    connecting = null;
  });
}

async function request(method: string, params: unknown, version = 1, allowBeforeInitialized = false): Promise<IpcResponse> {
  if (!allowBeforeInitialized) {
    await connect();
  }

  const requestId = randomUUID();
  send({
    type: "request",
    requestId,
    sourceClientId: clientId,
    version,
    method,
    params
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Codex Desktop IPC request timed out: ${method}`));
    }, 20000);

    pending.set(requestId, { resolve, reject, timer });
  });
}

async function startNotificationTurn(threadId: string, message: string): Promise<void> {
  const text = buildInputText(message);
  const modelOverride = config.agentModel ?? null;
  const response = await request("thread-follower-start-turn", {
    conversationId: threadId,
    turnStartParams: {
      input: [
        {
          type: "text",
          text,
          text_elements: []
        }
      ],
      cwd: config.codexCwd,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess"
      },
      model: null,
      effort: "high",
      serviceTier: null,
      attachments: [],
      commentAttachments: [],
      collaborationMode: {
        mode: "default",
        settings: {
          model: modelOverride,
          reasoning_effort: "high",
          developer_instructions: null
        }
      },
      outputSchema: null,
      responsesapiClientMetadata: null
    }
  });

  if (response.resultType !== "success") {
    throw new Error(`Codex Desktop IPC turn failed: ${response.error ?? JSON.stringify(response)}`);
  }

  monitorThreadActive = true;
}

function buildInputText(message: string): string {
  return message;
}

function combineMessages(messages: string[]): string {
  if (messages.length === 1) {
    return messages[0];
  }

  return [
    `QQ/NapCat 网关在短时间内收到 ${messages.length} 条实时提醒，请按时间顺序一起处理。`,
    "",
    ...messages.map((message, index) => [
      `--- 消息 ${index + 1}/${messages.length} ---`,
      message
    ].join("\n"))
  ].join("\n\n");
}

async function steerNotificationTurn(threadId: string, message: string): Promise<void> {
  const text = buildInputText(message);
  const response = await request("thread-follower-steer-turn", {
    conversationId: threadId,
    input: [
      {
        type: "text",
        text,
        text_elements: []
      }
    ],
    attachments: [],
    restoreMessage: {
      id: randomUUID(),
      text,
      context: {
        prompt: text,
        addedFiles: [],
        fileAttachments: [],
        ideContext: null,
        imageAttachments: [],
        workspaceRoots: [config.codexCwd]
      },
      cwd: config.codexCwd,
      createdAt: Date.now()
    }
  });

  if (response.resultType !== "success") {
    throw new Error(`Codex Desktop IPC steer failed: ${response.error ?? JSON.stringify(response)}`);
  }
}

function isInactiveSteerError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("SteerTurnInactiveError") || text.includes("active turn already ended") || text.includes("no active turn to steer");
}

function isNoClientFoundError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("no-client-found");
}

function shouldUseAppServerFallback(): boolean {
  return process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK !== "0";
}

async function deliverToMonitorThread(state: CodexState, message: string): Promise<void> {
  if (!state.monitorThreadId) {
    throw new Error(`Missing monitorThreadId in ${statePath}. RabiRoute tried to find "${config.codexThreadName}" in ${sessionIndexPath()}, but no matching Codex thread was found.`);
  }

  await connect();
  const shouldTrySteer = monitorThreadActive || (lastStartedTurnAt > 0 && Date.now() - lastStartedTurnAt < recentStartSteerWindowMs);
  if (shouldTrySteer) {
    try {
      await steerNotificationTurn(state.monitorThreadId, message);
    } catch (error) {
      if (!isInactiveSteerError(error)) {
        throw error;
      }

      monitorThreadActive = false;
      await startNotificationTurn(state.monitorThreadId, message);
      lastStartedTurnAt = Date.now();
    }
  } else {
    await startNotificationTurn(state.monitorThreadId, message);
    lastStartedTurnAt = Date.now();
  }
}

async function deliverCodexDesktopNotification(message: string): Promise<void> {
  notificationQueue = notificationQueue
    .catch(() => undefined)
    .then(async () => {
      let state = resolveConfiguredMonitorThread(readState(), false);

      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await deliverToMonitorThread(state, message);
            break;
          } catch (error) {
            if (attempt === 0 && isNoClientFoundError(error)) {
              const refreshedState = resolveMonitorThread(state, true);
              if (refreshedState.monitorThreadId && refreshedState.monitorThreadId !== state.monitorThreadId) {
                state = refreshedState;
                monitorThreadActive = false;
                continue;
              }
            }
            throw error;
          }
        }

        writeState({
          ...state,
          notificationCount: (state.notificationCount ?? 0) + 1,
          lastNotificationAt: new Date().toISOString(),
          lastNotificationError: undefined,
          lastNotificationErrorAt: undefined
        });
      } catch (error) {
        if (isNoClientFoundError(error) && shouldUseAppServerFallback()) {
          try {
            await notifyCodex(message);
            writeState({
              ...readState(),
              lastNotificationError: undefined,
              lastNotificationErrorAt: undefined,
              lastDesktopIpcError: error instanceof Error ? error.message : String(error),
              lastDesktopIpcErrorAt: new Date().toISOString(),
              lastDesktopIpcFallbackAt: new Date().toISOString()
            } as CodexState & Record<string, unknown>);
            return;
          } catch (fallbackError) {
            writeState({
              ...state,
              lastNotificationError: [
                error instanceof Error ? error.message : String(error),
                `app-server fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
              ].join("; "),
              lastNotificationErrorAt: new Date().toISOString()
            });
            throw fallbackError;
          }
        }
        writeState({
          ...state,
          lastNotificationError: error instanceof Error ? error.message : String(error),
          lastNotificationErrorAt: new Date().toISOString()
        });
        throw error;
      }
    });

  return notificationQueue;
}

function flushPendingMessages(): void {
  const messages = pendingMessages;
  const waiters = flushWaiters;
  pendingMessages = [];
  flushWaiters = [];
  flushTimer = null;

  void deliverCodexDesktopNotification(combineMessages(messages))
    .then(() => {
      for (const waiter of waiters) {
        waiter.resolve();
      }
    })
    .catch((error) => {
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    });
}

export async function notifyCodexDesktop(message: string): Promise<void> {
  pendingMessages.push(message);

  const result = new Promise<void>((resolve, reject) => {
    flushWaiters.push({ resolve, reject });
  });

  if (!flushTimer) {
    flushTimer = setTimeout(flushPendingMessages, notificationBatchDelayMs);
  }

  return result;
}
