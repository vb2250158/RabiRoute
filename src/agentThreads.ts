import fs from "node:fs";
import path from "node:path";
import {
  createCodexThread,
  listCodexThreads,
  readCodexThread,
  sendCodexThreadMessage,
  type CodexThreadCreateResult,
  type CodexTurnSandbox
} from "./codexRuntime.js";
import {
  isCodexTaskId
} from "./codexTaskIdentity.js";
import { resolveCodexSession } from "./codexSessionResolver.js";
import { normalizeCodexThreadTitle } from "./shared/codexThreadTitle.js";

const maxQueryLength = 240;
const maxTitleInputLength = 200_000;
const maxPromptLength = 200_000;
const maxListLimit = 200;
const defaultListLimit = 100;
const maxResolveCandidates = 10_000;

export type AgentThreadRequest = {
  action?: "list" | "read" | "resolve" | "create" | "send";
  query?: string;
  limit?: number;
  offset?: number;
  threadId?: string;
  title?: string;
  prompt?: string;
  cwd?: string;
  createIfMissing?: boolean;
  sandbox?: CodexTurnSandbox;
};

export type AgentThreadSummary = {
  id: string;
  title: string;
  updatedAt: string;
  cwd?: string;
  archived?: boolean;
};

export type AgentThreadDriver = {
  list?: (params: { query: string; limit: number; offset: number; allowedWorkspaces: string[] }) => Promise<AgentThreadSummary[]>;
  read: (threadId: string) => Promise<unknown>;
  create: (params: {
    title: string;
    prompt: string;
    cwd: string;
    developerInstructions: string;
    sandbox: CodexTurnSandbox;
  }) => Promise<CodexThreadCreateResult>;
  send: (params: { threadId: string; prompt: string; cwd: string; sandbox: CodexTurnSandbox }) => Promise<void>;
};

export type AgentThreadRequestOptions = {
  allowedWorkspaces: string[];
  defaultWorkspace?: string;
  sessionIndexPath?: string;
};

export type AgentThreadRequestResult = {
  statusCode: number;
  data: Record<string, unknown>;
};

const defaultDriver: AgentThreadDriver = {
  list: listCodexThreads,
  read: readCodexThread,
  create: createCodexThread,
  send: sendCodexThreadMessage
};

function normalizeSandbox(value: unknown, fallback: CodexTurnSandbox = "workspace-write"): CodexTurnSandbox {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return fallback;
}

function requiredText(value: unknown, name: string, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new Error(`Missing ${name}.`);
  }
  if (text.length > maxLength) {
    throw new Error(`${name} is too long; maximum length is ${maxLength}.`);
  }
  return text;
}

function optionalText(value: unknown, name: string, maxLength: number): string {
  if (value == null || value === "") {
    return "";
  }
  return requiredText(value, name, maxLength);
}

function normalizeThreadId(value: unknown): string {
  const threadId = requiredText(value, "threadId", 80);
  if (!isCodexTaskId(threadId)) {
    throw new Error("Invalid threadId.");
  }
  return threadId;
}

function canonicalWorkspace(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function resolveAgentThreadWorkspaceForTest(
  requestedWorkspace: unknown,
  options: AgentThreadRequestOptions
): string {
  const allowed = options.allowedWorkspaces
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
  if (allowed.length === 0) {
    throw new Error("No Codex workspaces are configured for Agent thread creation.");
  }

  const requested = typeof requestedWorkspace === "string" && requestedWorkspace.trim()
    ? path.resolve(requestedWorkspace.trim())
    : path.resolve(options.defaultWorkspace?.trim() || allowed[0]);
  const requestedCanonical = canonicalWorkspace(requested);
  if (!allowed.some((item) => canonicalWorkspace(item) === requestedCanonical)) {
    throw new Error(`Workspace is not configured for Agent thread creation: ${requested}`);
  }
  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
    throw new Error(`Workspace does not exist or is not a directory: ${requested}`);
  }
  return requested;
}

function parseThreadIndex(content: string): AgentThreadSummary[] {
  const latestById = new Map<string, AgentThreadSummary>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const value = JSON.parse(line) as { id?: unknown; thread_name?: unknown; updated_at?: unknown };
      if (typeof value.id !== "string" || typeof value.thread_name !== "string" || typeof value.updated_at !== "string") {
        continue;
      }
      const candidate = {
        id: value.id,
        title: value.thread_name,
        updatedAt: value.updated_at
      };
      const current = latestById.get(candidate.id);
      if (!current || Date.parse(candidate.updatedAt) > Date.parse(current.updatedAt)) {
        latestById.set(candidate.id, candidate);
      }
    } catch {
      // Ignore incomplete or malformed JSONL records.
    }
  }
  return [...latestById.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function readThreadIndex(indexPath: string): AgentThreadSummary[] {
  if (!fs.existsSync(indexPath)) {
    return [];
  }
  return parseThreadIndex(fs.readFileSync(indexPath, "utf8"));
}

export function listAgentThreadsFromIndexForTest(
  content: string,
  query = "",
  limit = defaultListLimit
): AgentThreadSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return parseThreadIndex(content)
    .filter((item) => !normalizedQuery || item.title.toLocaleLowerCase().includes(normalizedQuery))
    .slice(0, Math.max(1, Math.min(maxListLimit, Math.floor(limit) || defaultListLimit)));
}

function listAgentThreads(query: string, limit: number, indexPath: string): AgentThreadSummary[] {
  const normalizedQuery = query.toLocaleLowerCase();
  return readThreadIndex(indexPath)
    .filter((item) => !normalizedQuery || item.title.toLocaleLowerCase().includes(normalizedQuery))
    .slice(0, limit);
}

function threadSummary(value: unknown): AgentThreadSummary | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.title !== "string") return null;
  return {
    id: item.id,
    title: item.title,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date(0).toISOString(),
    cwd: typeof item.cwd === "string" ? item.cwd : undefined,
    archived: item.archived === true
  };
}

function missingThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|was not found|no rollout found/i.test(message);
}

async function createThread(
  request: AgentThreadRequest,
  options: AgentThreadRequestOptions,
  driver: AgentThreadDriver,
  requestedTitle = requiredText(request.title, "title", maxTitleInputLength)
): Promise<CodexThreadCreateResult> {
  const title = normalizeCodexThreadTitle(requestedTitle);
  const prompt = optionalText(request.prompt, "prompt", maxPromptLength);
  const cwd = resolveAgentThreadWorkspaceForTest(request.cwd, options);
  const sandbox = normalizeSandbox(request.sandbox);
  return driver.create({
    title,
    prompt,
    cwd,
    developerInstructions: [
      "这是由 RabiRoute 会话管理层创建的独立 Codex 任务。",
      "严格按初始任务和用户后续消息处理，并遵守工作区中的 AGENTS.md 与任务明确引用的 Skill。",
      "运行沙箱权限不等于业务修改授权；没有明确授权时，只做读取、调查、证据整理和方案输出。",
      "开始工作前先读取当前任务的完整相关历史和已有结论，不得只看标题、摘要或最后一条消息。"
    ].join("\n"),
    sandbox
  });
}

async function listThreads(
  query: string,
  limit: number,
  offset: number,
  allowedWorkspaces: string[],
  options: AgentThreadRequestOptions,
  driver: AgentThreadDriver
): Promise<AgentThreadSummary[]> {
  if (driver.list) return driver.list({ query, limit, offset, allowedWorkspaces });
  if (!options.sessionIndexPath) return [];
  return listAgentThreads(query, limit + offset, options.sessionIndexPath).slice(offset, offset + limit);
}

export async function handleAgentThreadRequest(
  request: AgentThreadRequest,
  options: AgentThreadRequestOptions,
  driver: AgentThreadDriver = defaultDriver
): Promise<AgentThreadRequestResult> {
  const action = request.action;
  if (action === "list") {
    const query = optionalText(request.query, "query", maxQueryLength);
    const requestedLimit = Number(request.limit ?? defaultListLimit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(maxListLimit, Math.floor(requestedLimit)))
      : defaultListLimit;
    const requestedOffset = Number(request.offset ?? 0);
    const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;
    const page = await listThreads(query, limit + 1, offset, options.allowedWorkspaces, options, driver);
    const hasMore = page.length > limit;
    const threads = page.slice(0, limit);
    return {
      statusCode: 200,
      data: { action, query, offset, threads, nextOffset: hasMore ? offset + threads.length : null }
    };
  }

  if (action === "read") {
    const threadId = normalizeThreadId(request.threadId);
    return {
      statusCode: 200,
      data: { action, threadId, thread: await driver.read(threadId) }
    };
  }

  if (action === "resolve") {
    const rawThreadId = optionalText(request.threadId, "threadId", 80);
    const fallbackTitle = !isCodexTaskId(rawThreadId) ? rawThreadId : "";
    const title = requiredText(request.title || fallbackTitle, "title", maxTitleInputLength);
    const requestedWorkspace = resolveAgentThreadWorkspaceForTest(request.cwd, options);
    const resolution = await resolveCodexSession({
      threadId: rawThreadId,
      title,
      cwd: requestedWorkspace,
      createIfMissing: request.createIfMissing !== false
    }, {
      scope: driver,
      read: async (threadId) => {
        try {
          return threadSummary(await driver.read(threadId));
        } catch (error) {
          if (missingThreadError(error)) return null;
          throw error;
        }
      },
      list: ({ title: query, cwd }) => listThreads(
        query,
        maxResolveCandidates,
        0,
        [cwd],
        options,
        driver
      ),
      create: () => createThread({ ...request, title, cwd: requestedWorkspace }, options, driver, title)
    });

    if (resolution.kind === "workspace-mismatch") {
      return {
        statusCode: 409,
        data: {
          action,
          resolution: "workspace-mismatch",
          message: `Codex Desktop task belongs to another workspace. Task: ${resolution.thread.cwd}; configured: ${requestedWorkspace}`,
          thread: resolution.thread
        }
      };
    }
    if (resolution.kind === "ambiguous") {
      return {
        statusCode: 409,
        data: {
          action,
          resolution: "ambiguous",
          message: `存在 ${resolution.candidates.length} 个同名 Codex Desktop 任务，请按最后会话时间选择。`,
          candidates: resolution.candidates
        }
      };
    }
    if (resolution.kind === "archived") {
      return {
        statusCode: 409,
        data: {
          action,
          resolution: "archived",
          message: `已绑定的 Codex Desktop 任务已归档，请恢复该任务或重新选择：${title}`,
          thread: resolution.thread
        }
      };
    }
    if (resolution.kind === "missing") {
      return {
        statusCode: 404,
        data: { action, resolution: "missing", message: `没有找到 Codex Desktop 任务：${title}` }
      };
    }
    return {
      statusCode: resolution.kind === "created" ? 201 : 200,
      data: { action, resolution: resolution.kind, thread: resolution.thread }
    };
  }

  if (action === "create") {
    const sandbox = normalizeSandbox(request.sandbox);
    const thread = await createThread(request, options, driver);
    return { statusCode: 201, data: { action, thread, sandbox } };
  }

  if (action === "send") {
    const threadId = normalizeThreadId(request.threadId);
    const prompt = requiredText(request.prompt, "prompt", maxPromptLength);
    const cwd = resolveAgentThreadWorkspaceForTest(request.cwd, options);
    const sandbox = normalizeSandbox(request.sandbox);
    await driver.send({ threadId, prompt, cwd, sandbox });
    return { statusCode: 202, data: { action, threadId, status: "started", sandbox } };
  }

  throw new Error("Unsupported Agent thread action. Expected list, read, resolve, create, or send.");
}
