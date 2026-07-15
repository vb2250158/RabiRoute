import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import {
  chatGptDesktopHostVisibilityStatePatch,
  ensureChatGptDesktopHostVisible
} from "./chatgptDesktopHost.js";
import { reportAgentState } from "./agentAdapters/stateReporter.js";
import { CodexAppServerClient } from "./codexAppServerClient.js";
import { rabiRoutePackageVersion } from "./packageInfo.js";

type AppServerNotification = {
  method?: string;
  params?: unknown;
};

type ThreadStatusChangedParams = {
  threadId?: string;
  status?: {
    type?: string;
  };
};

const activeTurnByThread = new Map<string, string>();
let notificationQueue: Promise<unknown> = Promise.resolve();
let memoryState: CodexState = {};
let appServerClient: CodexAppServerClient | null = null;
let cachedRuntimeDefaultModel: string | undefined;

process.once("exit", () => appServerClient?.close());

type CodexState = {
  monitorThreadId?: string;
  monitorThreadName?: string;
  monitorThreadCwd?: string;
  monitorThreadUpdatedAt?: string;
  monitorThreadSource?: string;
  lastAutoDiscoveryAt?: string;
  notificationCount?: number;
  lastNotificationAt?: string;
  lastNotificationError?: string;
  lastNotificationErrorAt?: string;
  lastDeliveryChannel?: string;
  lastDeliveryAcceptedAt?: string;
  lastChatGptDesktopHostVisibilityAt?: string;
  lastChatGptDesktopHostVisibilityReason?: string;
  lastChatGptDesktopHostVisibilityMode?: string;
  lastChatGptDesktopHostVisibilityTarget?: string;
  lastChatGptDesktopHostVisibilityError?: string;
};

type DiscoveredMonitorThread = {
  id: string;
  threadName: string;
  updatedAt: string;
  source: string;
  cwd?: string;
};

export type CodexMonitorThread = {
  id: string;
  threadName: string;
  updatedAt: string;
  source: string;
  cwd?: string;
};

export type CodexIdleNotificationResult = {
  status: "delivered" | "busy";
  thread: CodexMonitorThread;
};

export type CodexTurnSandbox = "read-only" | "workspace-write" | "danger-full-access";

export type CodexThreadSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export type CodexThreadCreateParams = {
  title: string;
  prompt: string;
  cwd: string;
  developerInstructions: string;
  sandbox: CodexTurnSandbox;
};

export type CodexThreadCreateResult = CodexThreadSummary & {
  source: "codex app-server stdio";
  initialTurnStatus: "started" | "failed";
  initialTurnError?: string;
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
    monitorThreadCwd: _monitorThreadCwd,
    monitorThreadUpdatedAt: _monitorThreadUpdatedAt,
    monitorThreadSource: _monitorThreadSource,
    ...rest
  } = state;
  writeState(rest);
}

function requestOptionalChatGptHostVisibility(
  reason: Parameters<typeof ensureChatGptDesktopHostVisible>[0],
  options: Parameters<typeof ensureChatGptDesktopHostVisible>[1] = {}
): void {
  void ensureChatGptDesktopHostVisible(reason, options)
    .then((result) => {
      const patch = chatGptDesktopHostVisibilityStatePatch(result);
      if (Object.keys(patch).length > 0) writeState({ ...readState(), ...patch });
    })
    .catch((error) => {
      writeState({
        ...readState(),
        lastChatGptDesktopHostVisibilityAt: new Date().toISOString(),
        lastChatGptDesktopHostVisibilityReason: reason,
        lastChatGptDesktopHostVisibilityError: errorMessage(error)
      });
    });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function turnErrorMessage(value: unknown, fallback: string): string {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message.trim() : "";
    const detail = typeof record.additionalDetails === "string" ? record.additionalDetails.trim() : "";
    if (message && detail) return `${message}: ${detail}`;
    if (message) return message;
  }
  return fallback;
}

function recordCodexFailure(error: unknown): void {
  writeState({
    ...readState(),
    lastDeliveryChannel: "app-server-stdio",
    lastNotificationError: errorMessage(error),
    lastNotificationErrorAt: new Date().toISOString()
  });
}

export function codexThreadDeliveryTargetIsStaleForTest(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("thread not found")
    || message.includes("no rollout found for thread id");
}

function codexLaunchCommand(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url))]
  };
}

export function buildChildEnvWithNodeOnPath(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  delimiter: string = path.delimiter
): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] || "";
  const nextEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() !== "path") {
      nextEnv[key] = value;
    }
  }
  nextEnv[pathKey] = [path.dirname(execPath), currentPath].filter(Boolean).join(delimiter);
  return nextEnv;
}

function handleNotification(msg: AppServerNotification): void {
  if (msg.method === "turn/started") {
    const params = msg.params as { threadId?: string; turn?: { id?: string } };
    if (params.threadId && params.turn?.id) activeTurnByThread.set(params.threadId, params.turn.id);
    return;
  }
  if (msg.method === "turn/completed") {
    const params = msg.params as {
      threadId?: string;
      turn?: { status?: string; error?: unknown };
    };
    if (params.threadId) activeTurnByThread.delete(params.threadId);
    if (params.threadId && (params.turn?.status === "failed" || params.turn?.status === "interrupted")) {
      const failure = new Error(turnErrorMessage(
        params.turn.error,
        `Codex turn ended with status ${params.turn.status}.`
      ));
      recordCodexFailure(failure);
    }
    return;
  }
  if (msg.method === "error") {
    const params = msg.params as { threadId?: string; error?: unknown; willRetry?: boolean };
    if (params.willRetry === true) return;
    const failure = new Error(turnErrorMessage(params.error, "Codex app-server reported a terminal turn error."));
    recordCodexFailure(failure);
    return;
  }
  if (msg.method !== "thread/status/changed") {
    return;
  }

  const params = msg.params as ThreadStatusChangedParams;
  const threadId = params.threadId;
  const status = params.status?.type;
  if (!threadId || (status !== "idle" && status !== "systemError")) {
    return;
  }
  activeTurnByThread.delete(threadId);

  if (status === "systemError") {
    const failure = new Error(`Codex thread entered systemError: ${threadId}`);
    recordCodexFailure(failure);
  }
}

function handleAppServerExit(error: Error): void {
  activeTurnByThread.clear();
  cachedRuntimeDefaultModel = undefined;
  recordCodexFailure(error);
}

function getAppServerClient(): CodexAppServerClient {
  if (!appServerClient) {
    const launch = codexLaunchCommand();
    appServerClient = new CodexAppServerClient({
      command: launch.command,
      commandArgs: launch.args,
      cwd: config.codexCwd,
      dataDir: config.dataDir,
      env: buildChildEnvWithNodeOnPath(),
      clientVersion: rabiRoutePackageVersion(),
      onNotification: handleNotification,
      onExit: handleAppServerExit
    });
  }
  return appServerClient;
}

async function connect(): Promise<void> {
  await getAppServerClient().start();
}

async function request(method: string, params: unknown): Promise<unknown> {
  return getAppServerClient().request(method, params);
}

async function resolveCodexModel(): Promise<string> {
  const configuredModel = config.agentModel?.trim();
  if (configuredModel) return configuredModel;
  if (cachedRuntimeDefaultModel) return cachedRuntimeDefaultModel;

  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const result = await request("model/list", {
      cursor,
      limit: 100,
      includeHidden: true
    }) as { data?: Array<Record<string, unknown>>; nextCursor?: string | null };
    const defaultModel = (result.data ?? []).find((item) => item.isDefault === true);
    const model = typeof defaultModel?.model === "string" && defaultModel.model.trim()
      ? defaultModel.model.trim()
      : typeof defaultModel?.id === "string" && defaultModel.id.trim()
        ? defaultModel.id.trim()
        : "";
    if (model) {
      cachedRuntimeDefaultModel = model;
      return model;
    }
    cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
    if (!cursor) break;
  }

  throw new Error("Codex runtime did not report a default model from model/list.");
}

type ReadableThreadInfo = {
  id: string;
  name?: string;
  cwd?: string;
  updatedAt?: string;
};

function normalizeComparablePath(value: string | undefined): string {
  if (!value) return "";
  const normalized = path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function codexThreadMatchesConfiguredTargetForTest(
  info: { name?: string; cwd?: string } | null,
  threadName: string,
  codexCwd: string
): boolean {
  if (!info || info.name !== threadName) return false;
  const normalized = normalizeComparablePath(info.cwd);
  return Boolean(normalized) && normalized === normalizeComparablePath(codexCwd);
}

async function readThreadInfo(threadId: string): Promise<ReadableThreadInfo | null> {
  try {
    const result = await request("thread/read", { threadId }) as { thread?: Record<string, unknown> };
    const thread = result.thread;
    if (!thread || typeof thread.id !== "string") {
      return null;
    }
    return {
      id: thread.id,
      name: typeof thread.name === "string" ? thread.name : undefined,
      cwd: typeof thread.cwd === "string" ? thread.cwd : undefined,
      updatedAt: typeof thread.updatedAt === "number"
        ? new Date(thread.updatedAt * 1000).toISOString()
        : typeof thread.updatedAt === "string" ? thread.updatedAt : undefined
    };
  } catch (error) {
    if (codexThreadDeliveryTargetIsStaleForTest(error)) return null;
    throw error;
  }
}

async function resumeThread(threadId: string, model: string): Promise<boolean> {
  try {
    const result = await request("thread/resume", {
      threadId,
      model,
      cwd: config.codexCwd,
      approvalPolicy: "never",
      sandbox: "workspace-write"
    }) as { thread?: { turns?: unknown } };
    const activeTurnId = activeTurnIdFromResumedThreadForTest(result.thread);
    if (activeTurnId) activeTurnByThread.set(threadId, activeTurnId);
    else activeTurnByThread.delete(threadId);
    return true;
  } catch (error) {
    if (codexThreadDeliveryTargetIsStaleForTest(error)) return false;
    throw error;
  }
}

export function activeTurnIdFromResumedThreadForTest(thread: { turns?: unknown } | undefined): string | undefined {
  if (!Array.isArray(thread?.turns)) return undefined;
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = thread.turns[index];
    if (!turn || typeof turn !== "object") continue;
    const candidate = turn as { id?: unknown; status?: unknown };
    if (candidate.status === "inProgress" && typeof candidate.id === "string" && candidate.id) {
      return candidate.id;
    }
  }
  return undefined;
}

function sandboxPolicyFor(cwd: string, sandbox: CodexTurnSandbox): Record<string, unknown> {
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (sandbox === "read-only") return { type: "readOnly" };
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

function threadUpdatedAt(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return new Date(0).toISOString();
}

export async function listCodexThreads(options: {
  query?: string;
  limit?: number;
  allowedWorkspaces: string[];
}): Promise<CodexThreadSummary[]> {
  await connect();
  const query = options.query?.trim() ?? "";
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20) || 20));
  const workspaces = [...new Map(
    options.allowedWorkspaces
      .map((cwd) => path.resolve(cwd))
      .map((cwd) => [normalizeComparablePath(cwd), cwd] as const)
  ).values()];
  const threads = new Map<string, CodexThreadSummary>();

  for (const cwd of workspaces) {
    let cursor: string | null = null;
    for (let page = 0; page < 10 && threads.size < limit; page += 1) {
      const result = await request("thread/list", {
        cursor,
        limit: Math.min(100, limit),
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
        archived: false,
        cwd,
        searchTerm: query || undefined
      }) as { data?: Array<Record<string, unknown>>; nextCursor?: string | null };
      for (const thread of result.data ?? []) {
        if (typeof thread.id !== "string" || !thread.id) continue;
        const threadCwd = typeof thread.cwd === "string" ? thread.cwd : "";
        if (normalizeComparablePath(threadCwd) !== normalizeComparablePath(cwd)) continue;
        const title = typeof thread.name === "string" && thread.name.trim() ? thread.name.trim() : thread.id;
        if (query && !title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
        const candidate = { id: thread.id, title, updatedAt: threadUpdatedAt(thread.updatedAt) };
        const current = threads.get(candidate.id);
        if (!current || Date.parse(candidate.updatedAt) > Date.parse(current.updatedAt)) {
          threads.set(candidate.id, candidate);
        }
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
      if (!cursor) break;
    }
  }

  return [...threads.values()]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, limit);
}

export async function readCodexThread(threadId: string): Promise<unknown> {
  await connect();
  return request("thread/read", { threadId });
}

async function startCodexThreadTurn(params: {
  threadId: string;
  prompt: string;
  cwd: string;
  sandbox: CodexTurnSandbox;
  resumeFirst: boolean;
}): Promise<void> {
  await connect();
  const model = await resolveCodexModel();
  if (params.resumeFirst) {
    const resumed = await request("thread/resume", {
      threadId: params.threadId,
      model,
      cwd: params.cwd,
      approvalPolicy: "never",
      sandbox: params.sandbox
    }) as { thread?: { turns?: unknown } };
    const activeTurnId = activeTurnIdFromResumedThreadForTest(resumed.thread);
    if (activeTurnId) activeTurnByThread.set(params.threadId, activeTurnId);
    else activeTurnByThread.delete(params.threadId);
  }

  const clientUserMessageId = randomUUID();
  const input = [{ type: "text", text: params.prompt, text_elements: [] }];
  const activeTurnId = activeTurnByThread.get(params.threadId);
  if (activeTurnId) {
    await request("turn/steer", {
      threadId: params.threadId,
      clientUserMessageId,
      input,
      expectedTurnId: activeTurnId
    });
    return;
  }

  const result = await request("turn/start", {
    threadId: params.threadId,
    clientUserMessageId,
    input,
    cwd: params.cwd,
    approvalPolicy: "never",
    sandboxPolicy: sandboxPolicyFor(params.cwd, params.sandbox),
    model,
    effort: "medium",
    personality: "friendly"
  }) as { turn?: { id?: string } };
  if (result.turn?.id) activeTurnByThread.set(params.threadId, result.turn.id);
}

export async function createCodexThread(params: CodexThreadCreateParams): Promise<CodexThreadCreateResult> {
  await connect();
  const model = await resolveCodexModel();
  const result = await request("thread/start", {
    cwd: params.cwd,
    approvalPolicy: "never",
    sandbox: params.sandbox,
    ephemeral: false,
    serviceName: "rabiroute",
    developerInstructions: params.developerInstructions,
    model
  }) as { thread?: { id?: string } };
  const threadId = result.thread?.id;
  if (!threadId) throw new Error(`thread/start did not return thread id: ${JSON.stringify(result)}`);
  await request("thread/name/set", { threadId, name: params.title });
  requestOptionalChatGptHostVisibility("app-server-create-thread", { force: true });

  const created: CodexThreadCreateResult = {
    id: threadId,
    title: params.title,
    updatedAt: new Date().toISOString(),
    source: "codex app-server stdio",
    initialTurnStatus: "started"
  };
  try {
    await startCodexThreadTurn({ ...params, threadId, resumeFirst: false });
  } catch (error) {
    created.initialTurnStatus = "failed";
    created.initialTurnError = errorMessage(error);
  }
  return created;
}

export async function sendCodexThreadMessage(params: {
  threadId: string;
  prompt: string;
  cwd: string;
  sandbox: CodexTurnSandbox;
}): Promise<void> {
  await startCodexThreadTurn({ ...params, resumeFirst: true });
  requestOptionalChatGptHostVisibility("app-server-turn-start");
}

async function findThreadsByName(threadName: string): Promise<DiscoveredMonitorThread[]> {
  const found: DiscoveredMonitorThread[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const result = await request("thread/list", {
      cursor,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
      archived: false,
      cwd: config.codexCwd,
      searchTerm: threadName
    }) as { data?: Array<Record<string, unknown>>; nextCursor?: string | null };
    for (const thread of result.data ?? []) {
      if (typeof thread.id !== "string" || thread.name !== threadName) continue;
      const cwd = typeof thread.cwd === "string" ? thread.cwd : undefined;
      if (!codexThreadMatchesConfiguredTargetForTest({ name: threadName, cwd }, threadName, config.codexCwd)) continue;
      const updatedAt = typeof thread.updatedAt === "number"
        ? new Date(thread.updatedAt * 1000).toISOString()
        : typeof thread.updatedAt === "string" ? thread.updatedAt : new Date(0).toISOString();
      found.push({
        id: thread.id,
        threadName,
        cwd,
        updatedAt,
        source: "codex app-server stdio thread/list"
      });
    }
    cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
    if (!cursor) break;
  }
  return found.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export async function isCodexMonitorThreadActive(): Promise<boolean> {
  await connect();
  const state = readState();
  const model = await resolveCodexModel();
  const candidates = await findThreadsByName(config.codexThreadName);
  if (state.monitorThreadId && !candidates.some((thread) => thread.id === state.monitorThreadId)) {
    const info = await readThreadInfo(state.monitorThreadId);
    if (info && codexThreadMatchesConfiguredTargetForTest(info, config.codexThreadName, config.codexCwd)) {
      candidates.unshift({
        id: info.id,
        threadName: config.codexThreadName,
        cwd: info.cwd,
        updatedAt: info.updatedAt ?? new Date(0).toISOString(),
        source: "codex app-server stdio thread/read"
      });
    }
  }

  for (const candidate of candidates) {
    if (!await resumeThread(candidate.id, model)) continue;
    bindThread(state, candidate);
    return activeTurnByThread.has(candidate.id);
  }
  return false;
}

function bindThread(state: CodexState, thread: DiscoveredMonitorThread): void {
  writeState({
    ...state,
    monitorThreadId: thread.id,
    monitorThreadName: thread.threadName,
    monitorThreadCwd: thread.cwd,
    monitorThreadUpdatedAt: thread.updatedAt,
    monitorThreadSource: thread.source,
    lastAutoDiscoveryAt: new Date().toISOString()
  });
}

async function ensureMonitorThread(): Promise<string> {
  const state = readState();
  const threadName = config.codexThreadName;
  await connect();
  const model = await resolveCodexModel();

  const existingThreads = await findThreadsByName(threadName);
  if (existingThreads.length > 0) {
    for (const existingThread of existingThreads) {
      const info = await readThreadInfo(existingThread.id);
      if (info && codexThreadMatchesConfiguredTargetForTest(info, threadName, config.codexCwd)) {
        if (!await resumeThread(existingThread.id, model)) continue;
        bindThread(state, {
          ...existingThread,
          updatedAt: info.updatedAt ?? existingThread.updatedAt,
          cwd: info.cwd
        });
        return existingThread.id;
      }
    }
  }

  if (state.monitorThreadId && (!state.monitorThreadName || state.monitorThreadName === threadName)) {
    const info = await readThreadInfo(state.monitorThreadId);
    if (info && codexThreadMatchesConfiguredTargetForTest(info, threadName, config.codexCwd)) {
      if (await resumeThread(state.monitorThreadId, model)) return state.monitorThreadId;
    }
    clearMonitorThreadId();
  }

  const threadStartParams: Record<string, unknown> = {
    cwd: config.codexCwd,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    ephemeral: false,
    serviceName: "rabiroute"
  };
  threadStartParams.model = model;

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
    monitorThreadCwd: config.codexCwd,
    monitorThreadUpdatedAt: new Date().toISOString(),
    monitorThreadSource: "codex app-server",
    lastAutoDiscoveryAt: new Date().toISOString()
  });
  requestOptionalChatGptHostVisibility("app-server-create-thread", { force: true });
  return threadId;
}

export async function notifyCodex(message: string): Promise<CodexMonitorThread> {
  const result = notificationQueue
    .catch(() => undefined)
    .then(() => notifyCodexInternal(message));

  notificationQueue = result;
  try {
    return await result;
  } catch (error) {
    recordCodexFailure(error);
    throw error;
  }
}

export async function notifyCodexWhenIdle(message: string): Promise<CodexIdleNotificationResult> {
  const result = notificationQueue
    .catch(() => undefined)
    .then(() => notifyCodexWhenIdleInternal(message));

  notificationQueue = result;
  try {
    return await result;
  } catch (error) {
    recordCodexFailure(error);
    throw error;
  }
}

function currentMonitorThread(threadId: string, threadName: string, fallbackUpdatedAt: string): CodexMonitorThread {
  const state = readState();
  return {
    id: threadId,
    threadName,
    updatedAt: state.monitorThreadUpdatedAt ?? fallbackUpdatedAt,
    source: state.monitorThreadSource ?? "codex app-server",
    cwd: state.monitorThreadCwd
  };
}

function recordAcceptedNotification(
  threadId: string,
  threadName: string,
  now: Date,
  notificationCount: number
): CodexMonitorThread {
  const acceptedAt = new Date();
  const currentState = readState();
  const terminalFailureDuringDelivery = Boolean(
    currentState.lastNotificationError
      && currentState.lastNotificationErrorAt
      && Date.parse(currentState.lastNotificationErrorAt) >= now.getTime()
  );
  const nextState = {
    ...currentState,
    monitorThreadId: threadId,
    monitorThreadName: threadName,
    monitorThreadCwd: config.codexCwd,
    notificationCount,
    lastNotificationAt: now.toISOString(),
    lastDeliveryChannel: "app-server-stdio",
    lastDeliveryAcceptedAt: acceptedAt.toISOString(),
    lastNotificationError: terminalFailureDuringDelivery ? currentState.lastNotificationError : "",
    lastNotificationErrorAt: terminalFailureDuringDelivery ? currentState.lastNotificationErrorAt : ""
  };
  writeState(nextState);
  return {
    id: threadId,
    threadName,
    updatedAt: nextState.monitorThreadUpdatedAt ?? now.toISOString(),
    source: nextState.monitorThreadSource ?? "codex app-server",
    cwd: nextState.monitorThreadCwd
  };
}

async function notifyCodexInternal(message: string): Promise<CodexMonitorThread> {
  const state = readState();
  const notificationCount = (state.notificationCount ?? 0) + 1;
  const now = new Date();
  const threadName = config.codexThreadName;
  const clientUserMessageId = randomUUID();

  let threadId = await ensureMonitorThread();

  try {
    await startNotificationTurn(threadId, threadName, message, clientUserMessageId);
  } catch (error) {
    if (!codexThreadDeliveryTargetIsStaleForTest(error)) {
      throw error;
    }

    clearMonitorThreadId();
    threadId = await ensureMonitorThread();
    await startNotificationTurn(threadId, threadName, message, clientUserMessageId);
  }
  return recordAcceptedNotification(threadId, threadName, now, notificationCount);
}

async function notifyCodexWhenIdleInternal(message: string): Promise<CodexIdleNotificationResult> {
  const state = readState();
  const notificationCount = (state.notificationCount ?? 0) + 1;
  const now = new Date();
  const threadName = config.codexThreadName;
  const clientUserMessageId = randomUUID();

  let threadId = await ensureMonitorThread();
  let delivery: "delivered" | "busy";
  try {
    delivery = await startNotificationTurn(threadId, threadName, message, clientUserMessageId, { allowSteer: false });
  } catch (error) {
    if (!codexThreadDeliveryTargetIsStaleForTest(error)) throw error;
    clearMonitorThreadId();
    threadId = await ensureMonitorThread();
    delivery = await startNotificationTurn(threadId, threadName, message, clientUserMessageId, { allowSteer: false });
  }

  if (delivery === "busy") {
    return {
      status: "busy",
      thread: currentMonitorThread(threadId, threadName, now.toISOString())
    };
  }
  return {
    status: "delivered",
    thread: recordAcceptedNotification(threadId, threadName, now, notificationCount)
  };
}

async function startNotificationTurn(
  threadId: string,
  threadName: string,
  message: string,
  clientUserMessageId: string,
  options: { allowSteer?: boolean } = {}
): Promise<"delivered" | "busy"> {
  await request("thread/name/set", {
    threadId,
    name: threadName
  });
  requestOptionalChatGptHostVisibility("app-server-turn-start");

  const input = [
    {
      type: "text",
      text: message,
      text_elements: []
    }
  ];
  const activeTurnId = activeTurnByThread.get(threadId);
  if (activeTurnId) {
    if (options.allowSteer === false) return "busy";
    try {
      await request("turn/steer", {
        threadId,
        clientUserMessageId,
        input,
        expectedTurnId: activeTurnId
      });
      return "delivered";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!/active turn|expectedTurnId|no active|not active/i.test(detail)) throw error;
      activeTurnByThread.delete(threadId);
    }
  }

  const turnStartParams: Record<string, unknown> = {
    threadId,
    clientUserMessageId,
    input,
    cwd: config.codexCwd,
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [config.codexCwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    }
  };
  turnStartParams.model = await resolveCodexModel();

  let result: { turn?: { id?: string } };
  try {
    result = await request("turn/start", turnStartParams) as { turn?: { id?: string } };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (options.allowSteer === false && /active turn|already running|in progress/i.test(detail)) return "busy";
    throw error;
  }
  if (result.turn?.id) activeTurnByThread.set(threadId, result.turn.id);
  return "delivered";
}
