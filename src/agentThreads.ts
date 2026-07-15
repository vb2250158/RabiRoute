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

const maxQueryLength = 240;
const maxTitleLength = 240;
const maxPromptLength = 200_000;
const maxListLimit = 100;
const defaultListLimit = 20;

export type AgentThreadRequest = {
  action?: "list" | "read" | "create" | "send";
  query?: string;
  limit?: number;
  threadId?: string;
  title?: string;
  prompt?: string;
  cwd?: string;
  sandbox?: CodexTurnSandbox;
};

export type AgentThreadSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export type AgentThreadDriver = {
  list?: (params: { query: string; limit: number; allowedWorkspaces: string[] }) => Promise<AgentThreadSummary[]>;
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
  if (!/^[0-9a-fA-F-]{16,80}$/.test(threadId)) {
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
    const threads = driver.list
      ? await driver.list({ query, limit, allowedWorkspaces: options.allowedWorkspaces })
      : options.sessionIndexPath
        ? listAgentThreads(query, limit, options.sessionIndexPath)
        : [];
    return {
      statusCode: 200,
      data: { action, query, threads }
    };
  }

  if (action === "read") {
    const threadId = normalizeThreadId(request.threadId);
    return {
      statusCode: 200,
      data: { action, threadId, thread: await driver.read(threadId) }
    };
  }

  if (action === "create") {
    const title = requiredText(request.title, "title", maxTitleLength);
    const prompt = requiredText(request.prompt, "prompt", maxPromptLength);
    const cwd = resolveAgentThreadWorkspaceForTest(request.cwd, options);
    const sandbox = normalizeSandbox(request.sandbox);
    const thread = await driver.create({
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

  throw new Error("Unsupported Agent thread action. Expected list, read, create, or send.");
}
