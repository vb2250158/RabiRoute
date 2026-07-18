import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { reportAgentState } from "./agentAdapters/stateReporter.js";
import { CodexAppServerClient } from "./codexAppServerClient.js";
import {
  CodexDesktopBridge,
  listCodexDesktopThreads,
  readCodexDesktopThread,
  type CodexDesktopThread
} from "./codexDesktopBridge.js";
import { canonicalCodexWorkspacePath, isCodexTaskId, sameCodexWorkspace } from "./codexTaskIdentity.js";
import {
  resolveAndDeliverCodexSession,
  resolveCodexSession,
  type CodexSessionResolverDependencies
} from "./codexSessionResolver.js";
import { rabiRoutePackageVersion } from "./packageInfo.js";

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
  cwd?: string;
  archived?: boolean;
};

export type CodexThreadCreateParams = {
  title: string;
  prompt: string;
  cwd: string;
  developerInstructions: string;
  sandbox: CodexTurnSandbox;
};

export type CodexThreadCreateResult = CodexThreadSummary & {
  source: string;
  initialTurnStatus: "not-requested" | "started" | "failed";
  initialTurnError?: string;
};

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
  desktopHostRequired?: boolean;
};

const desktopBridge = new CodexDesktopBridge();
let memoryState: CodexState = {};
let notificationQueue: Promise<unknown> = Promise.resolve();

process.once("exit", () => desktopBridge.close());

function readState(): CodexState {
  return memoryState;
}

function writeState(state: CodexState): void {
  memoryState = state;
  reportAgentState("codex", state);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordCodexFailure(error: unknown): void {
  writeState({
    ...readState(),
    lastDeliveryChannel: "desktop-ipc",
    desktopHostRequired: true,
    lastNotificationError: errorMessage(error),
    lastNotificationErrorAt: new Date().toISOString()
  });
}

export function codexThreadMatchesConfiguredTargetForTest(
  thread: { name?: string; cwd?: string },
  threadName: string,
  codexCwd: string
): boolean {
  return thread.name === threadName
    && sameCodexWorkspace(thread.cwd, codexCwd);
}

export function codexThreadDeliveryTargetIsStaleForTest(error: unknown): boolean {
  const message = errorMessage(error).toLocaleLowerCase();
  return message.includes("thread not found")
    || message.includes("task was not found")
    || message.includes("no rollout found for thread id");
}

function codexLaunchCommand(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url))]
  };
}

function createCodexMetadataClient(cwd: string): CodexAppServerClient {
  const launch = codexLaunchCommand();
  return new CodexAppServerClient({
    command: launch.command,
    commandArgs: launch.args,
    cwd,
    dataDir: config.dataDir,
    env: buildCodexBootstrapEnv(),
    clientVersion: rabiRoutePackageVersion()
  });
}

type CodexAppServerThreadMetadata = {
  id?: unknown;
  name?: unknown;
  cwd?: unknown;
  updatedAt?: unknown;
};

type CodexAppServerThreadListResult = {
  data?: CodexAppServerThreadMetadata[];
  nextCursor?: string | null;
};

const codexThreadSourceKinds = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown"
];

function appServerThreadUpdatedAt(value: unknown, fallback: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  const timestampMs = value < 1_000_000_000_000 ? value * 1000 : value;
  const parsed = new Date(timestampMs);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

export function mergeCodexDesktopThreadsWithMetadataForTest(
  localThreads: CodexDesktopThread[],
  metadataThreads: CodexAppServerThreadMetadata[],
  options: { query?: string; limit?: number; offset?: number; allowedWorkspaces?: string[] } = {}
): CodexDesktopThread[] {
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const allowed = new Set((options.allowedWorkspaces ?? []).filter(Boolean).map(canonicalCodexWorkspacePath));
  const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 20) || 20));
  const offset = Math.max(0, Math.floor(options.offset ?? 0) || 0);
  const localById = new Map(localThreads.map((thread) => [thread.id, thread]));

  return metadataThreads.flatMap((metadata) => {
    const id = typeof metadata.id === "string" ? metadata.id.trim() : "";
    const local = localById.get(id);
    if (!local || local.archived) return [];
    const title = typeof metadata.name === "string" && metadata.name.trim()
      ? metadata.name.trim()
      : local.title;
    const metadataCwd = typeof metadata.cwd === "string" ? metadata.cwd.trim() : "";
    const cwd = metadataCwd || local.cwd;
    if (query && !title.toLocaleLowerCase().includes(query)) return [];
    if (allowed.size > 0 && (!cwd || !allowed.has(canonicalCodexWorkspacePath(cwd)))) return [];
    if (metadataCwd && local.cwd && !sameCodexWorkspace(metadataCwd, local.cwd)) return [];
    return [{
      ...local,
      title,
      cwd,
      updatedAt: appServerThreadUpdatedAt(metadata.updatedAt, local.updatedAt)
    }];
  }).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(offset, offset + limit);
}

async function listCodexDesktopThreadsWithMetadata(options: {
  query?: string;
  limit?: number;
  offset?: number;
  allowedWorkspaces?: string[];
} = {}): Promise<CodexDesktopThread[]> {
  const client = createCodexMetadataClient(config.codexCwd || process.cwd());
  const metadataThreads: CodexAppServerThreadMetadata[] = [];
  const requestedCount = Math.max(1, Math.floor(options.offset ?? 0) + Math.floor(options.limit ?? 20));
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  try {
    let cursor: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const result = await client.request("thread/list", {
        cursor,
        limit: 100,
        sortKey: "recency_at",
        sortDirection: "desc",
        sourceKinds: codexThreadSourceKinds,
        archived: false,
        useStateDbOnly: false,
        cwd: options.allowedWorkspaces?.length ? options.allowedWorkspaces : undefined
      }) as CodexAppServerThreadListResult;
      metadataThreads.push(...(Array.isArray(result.data) ? result.data : []));
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
      const eligibleCount = query
        ? metadataThreads.filter((thread) => typeof thread.name === "string" && thread.name.toLocaleLowerCase().includes(query)).length
        : metadataThreads.length;
      if (!cursor || eligibleCount >= requestedCount) break;
    }
  } finally {
    client.close();
  }

  const localThreads = listCodexDesktopThreads({
    limit: 10_000,
    allowedWorkspaces: options.allowedWorkspaces
  });
  return mergeCodexDesktopThreadsWithMetadataForTest(localThreads, metadataThreads, options);
}

type CodexTaskBootstrap = {
  client: CodexAppServerClient;
  threadId: string;
};

/**
 * The bootstrap process is only used to create an empty persistent task when a
 * user typed a new title. It never executes the user's prompt. Actual turns are
 * always started by the Desktop owner over Desktop IPC.
 */
export function buildCodexBootstrapEnv(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  delimiter: string = path.delimiter
): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find((key) => key.toLocaleLowerCase() === "path") ?? "PATH";
  const nextEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toLocaleLowerCase();
    if (normalizedKey !== "path" && normalizedKey !== "codex_app_server_ws_url") nextEnv[key] = value;
  }
  nextEnv[pathKey] = [path.dirname(execPath), env[pathKey] || ""].filter(Boolean).join(delimiter);
  return nextEnv;
}

async function bootstrapEmptyDesktopThread(params: CodexThreadCreateParams): Promise<CodexTaskBootstrap> {
  const client = createCodexMetadataClient(params.cwd);
  try {
    const result = await client.request("thread/start", {
      cwd: params.cwd,
      sandbox: params.sandbox,
      ephemeral: false,
      serviceName: "rabiroute-desktop-bootstrap",
      developerInstructions: params.developerInstructions
    }) as { thread?: { id?: string } };
    const threadId = result.thread?.id;
    if (!threadId) throw new Error(`thread/start did not return thread id: ${JSON.stringify(result)}`);
    await client.request("thread/name/set", { threadId, name: params.title });
    return { client, threadId };
  } catch (error) {
    client.close();
    throw error;
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForDesktopFirstMessage(threadId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (readCodexDesktopThread(threadId)?.firstUserMessage) return;
    await wait(100);
  }
}

async function setCodexTaskName(
  threadId: string,
  title: string,
  cwd: string,
  existingClient?: CodexAppServerClient
): Promise<void> {
  const client = existingClient ?? createCodexMetadataClient(cwd);
  try {
    await client.request("thread/name/set", { threadId, name: title });
  } finally {
    if (!existingClient) client.close();
  }
}

async function deliverDesktopMessage(params: {
  thread: CodexDesktopThread;
  prompt: string;
  sandbox: CodexTurnSandbox;
}): Promise<string | null> {
  const preserveEmptyTaskTitle = !params.thread.firstUserMessage;
  await desktopBridge.deliver({
    threadId: params.thread.id,
    prompt: params.prompt,
    cwd: params.thread.cwd,
    sandbox: params.sandbox
  });
  if (preserveEmptyTaskTitle) {
    try {
      await waitForDesktopFirstMessage(params.thread.id);
      await setCodexTaskName(params.thread.id, params.thread.title, params.thread.cwd);
    } catch (error) {
      return `Desktop 已接收消息，但任务名恢复失败：${errorMessage(error)}`;
    }
  }
  return null;
}

function asSummary(thread: CodexDesktopThread): CodexThreadSummary {
  return { id: thread.id, title: thread.title, updatedAt: thread.updatedAt, cwd: thread.cwd, archived: thread.archived };
}

export async function listCodexThreads(options: {
  query?: string;
  limit?: number;
  offset?: number;
  allowedWorkspaces: string[];
}): Promise<CodexThreadSummary[]> {
  return (await listCodexDesktopThreadsWithMetadata(options)).map(asSummary);
}

export async function readCodexThread(threadId: string): Promise<unknown> {
  const thread = readCodexDesktopThread(threadId);
  if (!thread) throw new Error(`Codex Desktop task was not found: ${threadId}`);
  return {
    id: thread.id,
    title: thread.title,
    cwd: thread.cwd,
    updatedAt: thread.updatedAt,
    archived: thread.archived,
    source: "Codex Desktop state",
    rolloutPath: thread.rolloutPath
  };
}

export async function createCodexThread(params: CodexThreadCreateParams): Promise<CodexThreadCreateResult> {
  const bootstrap = await bootstrapEmptyDesktopThread(params);
  const created: CodexThreadCreateResult = {
    id: bootstrap.threadId,
    title: params.title,
    updatedAt: new Date().toISOString(),
    source: "Codex Desktop task bootstrap",
    initialTurnStatus: params.prompt.trim() ? "started" : "not-requested"
  };
  try {
    if (!params.prompt.trim()) return created;
    await desktopBridge.deliver({
      threadId: bootstrap.threadId,
      prompt: params.prompt,
      cwd: params.cwd,
      sandbox: params.sandbox
    });
    try {
      await waitForDesktopFirstMessage(bootstrap.threadId);
      await setCodexTaskName(bootstrap.threadId, params.title, params.cwd, bootstrap.client);
    } catch (error) {
      created.initialTurnError = `Desktop 已接收消息，但任务名恢复失败：${errorMessage(error)}`;
    }
  } catch (error) {
    created.initialTurnStatus = "failed";
    created.initialTurnError = errorMessage(error);
  } finally {
    bootstrap.client.close();
  }
  return created;
}

export async function waitForCodexDesktopThreadForTest(
  params: { threadId: string; cwd: string; attempts?: number; delayMs?: number },
  dependencies: {
    read: (threadId: string) => CodexDesktopThread | null;
    wait: (delayMs: number) => Promise<void>;
  } = { read: readCodexDesktopThread, wait }
): Promise<CodexDesktopThread> {
  const attempts = Math.max(1, params.attempts ?? 20);
  const delayMs = Math.max(1, params.delayMs ?? 100);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const thread = dependencies.read(params.threadId);
    if (thread) {
      if (!sameCodexWorkspace(thread.cwd, params.cwd)) {
        throw new Error(`Codex Desktop task belongs to another workspace. Task: ${thread.cwd}; configured: ${params.cwd}`);
      }
      return thread;
    }
    if (attempt + 1 < attempts) await dependencies.wait(delayMs);
  }
  throw new Error(`Codex Desktop task was not found after waiting for the Desktop index: ${params.threadId}`);
}

export async function sendCodexThreadMessage(params: {
  threadId: string;
  prompt: string;
  cwd: string;
  sandbox: CodexTurnSandbox;
}): Promise<void> {
  const thread = await waitForCodexDesktopThreadForTest({ threadId: params.threadId, cwd: params.cwd });
  await deliverDesktopMessage({ thread, prompt: params.prompt, sandbox: params.sandbox });
}

function monitorThreadFromDesktop(thread: CodexDesktopThread): CodexMonitorThread {
  return {
    id: thread.id,
    threadName: thread.title,
    updatedAt: thread.updatedAt,
    source: "Codex Desktop state + Desktop IPC",
    cwd: thread.cwd
  };
}

function rolloutShowsActive(rolloutPath: string): boolean {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return false;
  let latestTurnId = "";
  const terminalTurnIds = new Set<string>();
  try {
    for (const line of fs.readFileSync(rolloutPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
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
        if (typeof turnId === "string" && (
          eventType === "task_complete"
          || eventType === "turn_aborted"
          || eventType === "task_failed"
        )) terminalTurnIds.add(turnId);
      } catch {
        // Ignore an incomplete last JSONL record while Desktop is writing it.
      }
    }
  } catch {
    return false;
  }
  return Boolean(latestTurnId) && !terminalTurnIds.has(latestTurnId);
}

function bindDesktopThread(thread: CodexDesktopThread): CodexMonitorThread {
  const now = new Date().toISOString();
  writeState({
    ...readState(),
    monitorThreadId: thread.id,
    monitorThreadName: thread.title,
    monitorThreadCwd: thread.cwd,
    monitorThreadUpdatedAt: thread.updatedAt,
    monitorThreadSource: "Codex Desktop state + Desktop IPC",
    lastAutoDiscoveryAt: now,
    desktopHostRequired: true
  });
  return monitorThreadFromDesktop(thread);
}

function currentCodexThreadId(): string {
  const rememberedThreadId = readState().monitorThreadId;
  return isCodexTaskId(config.codexThreadId)
    ? config.codexThreadId
    : (isCodexTaskId(rememberedThreadId) ? rememberedThreadId : "");
}

function codexSessionDependencies(): CodexSessionResolverDependencies<CodexDesktopThread> {
  return {
    scope: desktopBridge,
    // Return the Desktop record as-is. The canonical resolver validates the
    // saved id + visible name + workspace together, then falls back to a name
    // lookup/create when any part is stale.
    read: async (candidateId) => readCodexDesktopThread(candidateId),
    list: async ({ title, cwd }) => listCodexDesktopThreadsWithMetadata({
      query: title,
      limit: 10_000,
      allowedWorkspaces: [cwd]
    }),
    create: async () => {
      const created = await createCodexThread({
        title: config.codexThreadName,
        prompt: "",
        cwd: config.codexCwd,
        developerInstructions: "这是由 RabiRoute 创建并交给 Codex Desktop 执行的任务。实际消息仅通过 Desktop IPC 投递。",
        sandbox: "workspace-write"
      });
      return waitForCodexDesktopThreadForTest({ threadId: created.id, cwd: config.codexCwd });
    }
  };
}

async function resolveMonitorThread(createIfMissing: boolean): Promise<CodexDesktopThread | null> {
  const resolution = await resolveCodexSession({
    threadId: currentCodexThreadId(),
    title: config.codexThreadName,
    cwd: config.codexCwd,
    createIfMissing
  }, codexSessionDependencies());

  if (resolution.kind === "ambiguous") {
    throw new Error(`Codex Desktop task name is ambiguous; select the exact task in RibiWebGUI: ${config.codexThreadName}`);
  }
  if (resolution.kind === "workspace-mismatch") {
    throw new Error(`Codex Desktop task belongs to another workspace. Task: ${resolution.thread.cwd}; configured: ${config.codexCwd}`);
  }
  if (resolution.kind === "archived") {
    throw new Error(`Codex Desktop task is archived; restore it or select another task in RibiWebGUI: ${config.codexThreadName}`);
  }
  if (resolution.kind === "missing") return null;
  return resolution.thread;
}

export async function isCodexMonitorThreadActive(): Promise<boolean> {
  const thread = await resolveMonitorThread(false);
  if (!thread) return false;
  bindDesktopThread(thread);
  return desktopBridge.isThreadActive(thread.id) || rolloutShowsActive(thread.rolloutPath);
}

function recordAcceptedNotification(thread: CodexDesktopThread, now: Date): CodexMonitorThread {
  const nextState: CodexState = {
    ...readState(),
    monitorThreadId: thread.id,
    monitorThreadName: thread.title,
    monitorThreadCwd: thread.cwd,
    monitorThreadUpdatedAt: now.toISOString(),
    monitorThreadSource: "Codex Desktop state + Desktop IPC",
    notificationCount: (readState().notificationCount ?? 0) + 1,
    lastNotificationAt: now.toISOString(),
    lastDeliveryChannel: "desktop-ipc",
    lastDeliveryAcceptedAt: new Date().toISOString(),
    lastNotificationError: "",
    lastNotificationErrorAt: "",
    desktopHostRequired: true
  };
  writeState(nextState);
  return {
    id: thread.id,
    threadName: thread.title,
    updatedAt: nextState.monitorThreadUpdatedAt ?? now.toISOString(),
    source: nextState.monitorThreadSource ?? "Codex Desktop IPC",
    cwd: thread.cwd
  };
}

async function deliverNotification(message: string): Promise<CodexMonitorThread> {
  const resolution = await resolveAndDeliverCodexSession({
    threadId: currentCodexThreadId(),
    title: config.codexThreadName,
    cwd: config.codexCwd,
    prompt: message
  }, {
    ...codexSessionDependencies(),
    deliver: ({ thread, prompt }) => deliverDesktopMessage({ thread, prompt, sandbox: "workspace-write" }).then(() => undefined)
  }, ({ thread }) => {
    bindDesktopThread(thread);
  });
  return recordAcceptedNotification(resolution.thread, new Date());
}

export async function notifyCodex(message: string): Promise<CodexMonitorThread> {
  const result = notificationQueue.catch(() => undefined).then(() => deliverNotification(message));
  notificationQueue = result;
  try {
    return await result;
  } catch (error) {
    recordCodexFailure(error);
    throw error;
  }
}

export async function notifyCodexWhenIdle(message: string): Promise<CodexIdleNotificationResult> {
  const result = notificationQueue.catch(() => undefined).then(async () => {
    const thread = await resolveMonitorThread(true);
    if (!thread) throw new Error("Codex Desktop task could not be resolved.");
    bindDesktopThread(thread);
    if (desktopBridge.isThreadActive(thread.id) || rolloutShowsActive(thread.rolloutPath)) {
      return { status: "busy", thread: monitorThreadFromDesktop(thread) } satisfies CodexIdleNotificationResult;
    }
    await deliverDesktopMessage({ thread, prompt: message, sandbox: "workspace-write" });
    return {
      status: "delivered",
      thread: recordAcceptedNotification(thread, new Date())
    } satisfies CodexIdleNotificationResult;
  });
  notificationQueue = result;
  try {
    return await result;
  } catch (error) {
    recordCodexFailure(error);
    throw error;
  }
}
