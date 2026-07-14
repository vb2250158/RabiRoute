import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import {
  type CodexAppVisibilityReason,
  codexAppVisibilityStatePatch,
  ensureCodexAppVisible
} from "./codexAppVisibility.js";
import { createCodexAppMonitorThread, notifyCodex, resumeCodexAppThread } from "./codexApp.js";
import { reportAgentState } from "./agentAdapters/stateReporter.js";

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
  retryPendingCount?: number;
  nextRetryAt?: string;
  lastRetryAt?: string;
  lastDeliveryChannel?: "desktop-ipc" | "app-server-fallback";
  lastDeliveryVisibility?: "desktop-client-confirmed" | "desktop-client-not-loaded" | "unknown";
  lastDeliveryAcceptedAt?: string;
  lastDesktopIpcError?: string;
  lastDesktopIpcErrorAt?: string;
  lastDesktopIpcFallbackAt?: string;
  lastCodexAppVisibilityAt?: string;
  lastCodexAppVisibilityReason?: string;
  lastCodexAppVisibilityMode?: string;
  lastCodexAppVisibilityTarget?: string;
  lastCodexAppVisibilityError?: string;
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

const pending = new Map<string, IpcPending>();
let memoryState: CodexState = {};

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
const defaultIpcRequestTimeoutMs = 30 * 60 * 1000;
const defaultRetryDelayMs = 60 * 1000;
const defaultMaxRetryMessages = 20;

export function isCodexMonitorThreadActive(): boolean {
  if (monitorThreadActive) {
    return true;
  }

  const state = resolveConfiguredMonitorThread(readState(), false);
  if (!state.monitorThreadId) {
    return false;
  }

  const transcriptPath = findCodexSessionTranscript(state.monitorThreadId, state.monitorThreadUpdatedAt);
  if (!transcriptPath) {
    return false;
  }

  try {
    return codexSessionTranscriptShowsActiveForTest(fs.readFileSync(transcriptPath, "utf8"));
  } catch {
    return false;
  }
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const ipcRequestTimeoutMs = positiveIntegerFromEnv("CODEX_DESKTOP_IPC_REQUEST_TIMEOUT_MS", defaultIpcRequestTimeoutMs);
const desktopRetryDelayMs = positiveIntegerFromEnv("CODEX_DESKTOP_IPC_RETRY_DELAY_MS", defaultRetryDelayMs);
const desktopMaxRetryMessages = positiveIntegerFromEnv("CODEX_DESKTOP_IPC_MAX_RETRY_MESSAGES", defaultMaxRetryMessages);

let retryMessages: string[] = [];
let retryTimer: NodeJS.Timeout | null = null;
let retryNextAt = "";

type DeliveryOptions = {
  fromRetry?: boolean;
};

function explicitCodexModel(): string | undefined {
  const envModel = process.env.RABIROUTE_CODEX_MODEL?.trim() || process.env.CODEX_MODEL?.trim();
  if (envModel) return envModel;
  return undefined;
}

function codexModelField(): string {
  return config.agentModel || explicitCodexModel() || "gpt-5.6-sol";
}

function readState(): CodexState {
  return memoryState;
}

function writeState(state: CodexState): void {
  memoryState = state;
  reportAgentState("codex", state);
}

function retryStatePatch(): Pick<CodexState, "retryPendingCount" | "nextRetryAt"> {
  return {
    retryPendingCount: retryMessages.length,
    nextRetryAt: retryNextAt
  };
}

function writeStateWithRetryMetadata(state: CodexState): void {
  writeState({
    ...state,
    ...retryStatePatch()
  });
}

function sessionIndexPath(): string {
  return path.join(os.homedir(), ".codex", "session_index.jsonl");
}

function codexSessionsRoot(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

function sessionDateDirectories(updatedAt?: string): string[] {
  const parsed = updatedAt ? new Date(updatedAt) : new Date();
  const center = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return [-1, 0, 1].map((offset) => {
    const candidate = new Date(center.getTime() + offset * 24 * 60 * 60 * 1000);
    return path.join(
      codexSessionsRoot(),
      String(candidate.getUTCFullYear()),
      String(candidate.getUTCMonth() + 1).padStart(2, "0"),
      String(candidate.getUTCDate()).padStart(2, "0")
    );
  });
}

function findCodexSessionTranscript(threadId: string, updatedAt?: string): string | null {
  for (const directory of sessionDateDirectories(updatedAt)) {
    if (!fs.existsSync(directory)) {
      continue;
    }

    const match = fs.readdirSync(directory)
      .find((fileName) => fileName.endsWith(`-${threadId}.jsonl`));
    if (match) {
      return path.join(directory, match);
    }
  }
  return null;
}

export function codexSessionTranscriptShowsActiveForTest(content: string): boolean {
  let latestTurnId = "";
  const terminalTurnIds = new Set<string>();

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const record = JSON.parse(line) as {
        type?: unknown;
        payload?: { type?: unknown; turn_id?: unknown };
      };
      if (record.type === "turn_context" && typeof record.payload?.turn_id === "string") {
        latestTurnId = record.payload.turn_id;
        continue;
      }

      const eventType = record.type === "event_msg" ? record.payload?.type : record.type;
      const turnId = record.payload?.turn_id;
      if (
        typeof turnId === "string"
        && (eventType === "task_complete" || eventType === "turn_aborted" || eventType === "task_failed")
      ) {
        terminalTurnIds.add(turnId);
      }
    } catch {
      // Ignore incomplete or malformed transcript lines.
    }
  }

  return Boolean(latestTurnId) && !terminalTurnIds.has(latestTurnId);
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

export function codexStateStillPointsToTargetThreadForTest(
  state: CodexState,
  records: DiscoveredMonitorThread[],
  targetName: string
): boolean {
  if (!state.monitorThreadId || state.monitorThreadName !== targetName) {
    return false;
  }

  const currentRecord = records.find((item) => item.id === state.monitorThreadId);
  if (currentRecord) {
    return currentRecord.threadName === targetName;
  }

  // If the session index already has another record for the configured name,
  // the cached id is stale and must not remain the binding source of truth.
  return !records.some((item) => item.threadName === targetName);
}

function stateStillPointsToTargetThread(state: CodexState): boolean {
  const targetName = config.codexThreadName.trim();
  return codexStateStillPointsToTargetThreadForTest(state, readLatestSessionThreads(), targetName);
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
    }, ipcRequestTimeoutMs);

    pending.set(requestId, { resolve, reject, timer });
  });
}

async function startNotificationTurn(threadId: string, message: string): Promise<void> {
  const text = buildInputText(message);
  const modelOverride = codexModelField();
  const collaborationSettings: Record<string, unknown> = {
    model: modelOverride,
    reasoning_effort: "medium",
    developer_instructions: ""
  };
  const turnStartParams: Record<string, unknown> = {
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
    effort: "medium",
    model: modelOverride,
    serviceTier: "",
    attachments: [],
    commentAttachments: [],
    collaborationMode: {
      mode: "default",
      settings: collaborationSettings
    }
  };

  const response = await request("thread-follower-start-turn", {
    conversationId: threadId,
    turnStartParams
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

function scheduleRetry(state: CodexState): void {
  if (retryTimer || retryMessages.length === 0) {
    writeStateWithRetryMetadata(state);
    return;
  }

  retryNextAt = new Date(Date.now() + desktopRetryDelayMs).toISOString();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryNextAt = "";
    void retryQueuedNotifications();
  }, desktopRetryDelayMs);
  writeStateWithRetryMetadata(state);
}

function enqueueRetryMessage(message: string, state: CodexState): void {
  retryMessages.push(message);
  if (retryMessages.length > desktopMaxRetryMessages) {
    retryMessages = retryMessages.slice(-desktopMaxRetryMessages);
  }
  scheduleRetry(state);
}

async function retryQueuedNotifications(): Promise<void> {
  if (retryMessages.length === 0) {
    writeStateWithRetryMetadata(readState());
    return;
  }

  const messages = retryMessages;
  retryMessages = [];
  writeStateWithRetryMetadata(readState());
  try {
    await deliverCodexDesktopNotification(combineMessages(messages), { fromRetry: true });
  } catch {
    // The delivery path records the concrete failure and requeues no-client-found
    // messages. Health patrols read that state instead of relying on this timer.
  }
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

function isDesktopRequestTimeoutError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("request-timeout") || text.includes("request timed out");
}

function isNoClientFoundError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("no-client-found");
}

function isMissingMonitorThreadError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("Missing monitorThreadId") || text.includes("no matching Codex thread was found");
}

export function shouldUseAppServerFallbackFor(error: unknown, state: CodexState): boolean {
  if (!shouldUseAppServerFallback()) {
    return false;
  }

  if (isMissingMonitorThreadError(error) && !shouldAutoCreateMonitorThread()) {
    return false;
  }

  if (isNoClientFoundError(error)) {
    return shouldFallbackOnNoClientFound();
  }

  return isMissingMonitorThreadError(error);
}

export function formatCodexDesktopDeliveryError(error: unknown, state: CodexState): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!isNoClientFoundError(error)) {
    return message;
  }

  const threadName = state.monitorThreadName || config.codexThreadName;
  const threadId = state.monitorThreadId || "<unknown>";
  return [
    `Codex Desktop 已找到线程 "${threadName}" (${threadId})，但该线程当前没有已加载的 Desktop 客户端。`,
    "RabiRoute 会先尝试启动/聚焦 Codex App，再通过 app-server thread/resume 唤醒这个线程。",
    "如果自动唤醒仍失败，默认会改走 app-server turn/start 兜底投递。",
    "RabiRoute 仍会暂存这次投递并定时重试；线程恢复加载后会自动补投。",
    "Codex App 可见性动作会记录到 lastCodexAppVisibility* 诊断字段。",
    "当前 codex_app.send_message_to_thread 是 Codex 连接器工具，不是 RabiRoute Node 运行时可直接调用的稳定 API。",
    `原始错误：${message}`
  ].join(" ");
}

function shouldUseAppServerFallback(): boolean {
  return process.env.CODEX_DESKTOP_IPC_APP_SERVER_FALLBACK !== "0";
}

function shouldFallbackOnNoClientFound(): boolean {
  return process.env.CODEX_DESKTOP_IPC_FALLBACK_ON_NO_CLIENT !== "0";
}

function shouldWakeOnNoClientFound(): boolean {
  return process.env.CODEX_DESKTOP_IPC_WAKE_ON_NO_CLIENT !== "0";
}

function shouldAutoCreateMonitorThread(): boolean {
  return process.env.CODEX_DESKTOP_IPC_AUTO_CREATE_THREAD !== "0";
}

async function ensureCodexAppVisibleForDelivery(
  state: CodexState,
  reason: CodexAppVisibilityReason,
  force = false
): Promise<CodexState> {
  const result = await ensureCodexAppVisible(reason, { force });
  const patch = codexAppVisibilityStatePatch(result);
  if (Object.keys(patch).length === 0) {
    return state;
  }

  const nextState = {
    ...state,
    ...patch
  };
  writeStateWithRetryMetadata(nextState);
  return nextState;
}

async function wakeMonitorThreadForDesktopDelivery(state: CodexState): Promise<boolean> {
  if (!state.monitorThreadId || !shouldWakeOnNoClientFound()) {
    return false;
  }

  await ensureCodexAppVisibleForDelivery(state, "app-server-resume-thread", true);
  await resumeCodexAppThread(state.monitorThreadId);
  return true;
}

async function createMonitorThreadForDesktopDelivery(state: CodexState, forceCreate = false): Promise<CodexState> {
  const created = await createCodexAppMonitorThread(forceCreate);
  const visibility = await ensureCodexAppVisible("app-server-create-thread", { force: true });
  const nextState = {
    ...state,
    ...codexAppVisibilityStatePatch(visibility),
    monitorThreadId: created.id,
    monitorThreadName: created.threadName,
    monitorThreadUpdatedAt: created.updatedAt,
    monitorThreadSource: `${created.source}; delivery=desktop-ipc`,
    lastAutoDiscoveryAt: new Date().toISOString(),
    lastNotificationError: "",
    lastNotificationErrorAt: "",
    retryPendingCount: retryMessages.length,
    nextRetryAt: retryNextAt
  };
  writeState(nextState);
  monitorThreadActive = false;
  return nextState;
}

async function startNotificationTurnWithFallback(threadId: string, message: string): Promise<"started" | "steered"> {
  try {
    await startNotificationTurn(threadId, message);
    return "started";
  } catch (error) {
    if (!isDesktopRequestTimeoutError(error)) {
      throw error;
    }

    try {
      await steerNotificationTurn(threadId, message);
      return "steered";
    } catch (steerError) {
      if (!isInactiveSteerError(steerError)) {
        throw steerError;
      }

      await startNotificationTurn(threadId, message);
      return "started";
    }
  }
}

async function deliverToMonitorThread(state: CodexState, message: string): Promise<void> {
  if (!state.monitorThreadId) {
    throw new Error(`Missing monitorThreadId. RabiRoute tried to find "${config.codexThreadName}" in ${sessionIndexPath()}, but no matching Codex thread was found.`);
  }

  state = await ensureCodexAppVisibleForDelivery(state, "desktop-ipc-delivery");
  const threadId = state.monitorThreadId;
  if (!threadId) {
    throw new Error(`Missing monitorThreadId after Codex App visibility check for "${config.codexThreadName}".`);
  }
  await connect();
  const shouldTrySteer = monitorThreadActive || (lastStartedTurnAt > 0 && Date.now() - lastStartedTurnAt < recentStartSteerWindowMs);
  if (shouldTrySteer) {
    try {
      await steerNotificationTurn(threadId, message);
    } catch (error) {
      if (!isInactiveSteerError(error)) {
        throw error;
      }

      monitorThreadActive = false;
      const result = await startNotificationTurnWithFallback(threadId, message);
      lastStartedTurnAt = Date.now();
      monitorThreadActive = result === "started" || result === "steered";
    }
  } else {
    const result = await startNotificationTurnWithFallback(threadId, message);
    lastStartedTurnAt = Date.now();
    monitorThreadActive = result === "started" || result === "steered";
  }
}

async function deliverCodexDesktopNotification(message: string, options: DeliveryOptions = {}): Promise<void> {
  notificationQueue = notificationQueue
    .catch(() => undefined)
    .then(async () => {
      const retryAttemptAt = options.fromRetry ? new Date().toISOString() : undefined;
      let state = resolveConfiguredMonitorThread(readState(), false);
      if (!state.monitorThreadId && shouldAutoCreateMonitorThread()) {
        state = await createMonitorThreadForDesktopDelivery(state);
      }

      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await deliverToMonitorThread(state, message);
            break;
          } catch (error) {
            if (isNoClientFoundError(error)) {
              const refreshedState = resolveMonitorThread(state, true);
              if (refreshedState.monitorThreadId && refreshedState.monitorThreadId !== state.monitorThreadId) {
                state = refreshedState;
                monitorThreadActive = false;
                continue;
              }
              if (attempt === 0 && await wakeMonitorThreadForDesktopDelivery(state)) {
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
          lastNotificationError: "",
          lastNotificationErrorAt: "",
          retryPendingCount: retryMessages.length,
          nextRetryAt: retryNextAt,
          lastRetryAt: retryAttemptAt ?? state.lastRetryAt,
          lastDeliveryChannel: "desktop-ipc",
          lastDeliveryVisibility: "desktop-client-confirmed",
          lastDeliveryAcceptedAt: new Date().toISOString()
        });
      } catch (error) {
        const deliveryErrorMessage = formatCodexDesktopDeliveryError(error, state);
        if (shouldUseAppServerFallbackFor(error, state)) {
          try {
            await notifyCodex(message);
            const visibility = await ensureCodexAppVisible("app-server-fallback", { force: true });
            const fallbackState = readState();
            const now = new Date().toISOString();
            writeState({
              ...fallbackState,
              ...codexAppVisibilityStatePatch(visibility),
              lastNotificationAt: now,
              lastNotificationError: "",
              lastNotificationErrorAt: "",
              lastDesktopIpcError: error instanceof Error ? error.message : String(error),
              lastDesktopIpcErrorAt: now,
              lastDesktopIpcFallbackAt: now,
              retryPendingCount: retryMessages.length,
              nextRetryAt: retryNextAt,
              lastRetryAt: retryAttemptAt ?? fallbackState.lastRetryAt,
              lastDeliveryChannel: "app-server-fallback",
              lastDeliveryVisibility: isNoClientFoundError(error) ? "desktop-client-not-loaded" : "unknown",
              lastDeliveryAcceptedAt: now
            } as CodexState & Record<string, unknown>);
            return;
          } catch (fallbackError) {
            const failedState = {
              ...state,
              lastNotificationError: [
                deliveryErrorMessage,
                `app-server fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
              ].join("; "),
              lastNotificationErrorAt: new Date().toISOString(),
              lastRetryAt: retryAttemptAt ?? state.lastRetryAt
            };
            if (isNoClientFoundError(error)) {
              enqueueRetryMessage(message, failedState);
            } else {
              writeStateWithRetryMetadata(failedState);
            }
            throw fallbackError;
          }
        }
        const failedState = {
          ...state,
          lastNotificationError: deliveryErrorMessage,
          lastNotificationErrorAt: new Date().toISOString(),
          lastRetryAt: retryAttemptAt ?? state.lastRetryAt
        };
        if (isNoClientFoundError(error)) {
          enqueueRetryMessage(message, failedState);
        } else {
          writeStateWithRetryMetadata(failedState);
        }
        throw new Error(deliveryErrorMessage);
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
