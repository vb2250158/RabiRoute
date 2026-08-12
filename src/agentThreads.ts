import fs from "node:fs";
import path from "node:path";
import {
  createCodexThread,
  listCodexThreads,
  readCodexThread,
  renameCodexThread,
  sendCodexThreadMessage,
  type CodexThreadCreateResult,
  type CodexTurnSandbox
} from "./codexRuntime.js";
import {
  isCodexTaskId
} from "./codexTaskIdentity.js";
import {
  resolveCodexSession,
  type CodexSessionResolution
} from "./codexSessionResolver.js";
import {
  CodexThreadCreationBlockedError,
  createCodexThreadWithReservation
} from "./codexThreadCreationReservations.js";
import { normalizeCodexThreadTitle } from "./shared/codexThreadTitle.js";
import { proactiveCommunicationPolicyLines } from "./shared/agentCommunicationPolicy.js";
import type { CodexReasoningEffort } from "./shared/gatewayConfigModel.js";
import { normalizePathForComparison } from "./shared/pathPolicy.js";
import {
  AgentRequestStore,
  type AgentCommunicationPreparation,
  type AgentResponsePolicy
} from "./agentRequests/store.js";

const maxQueryLength = 240;
const maxTitleInputLength = 200_000;
const maxPromptLength = 200_000;
const maxListLimit = 200;
const defaultListLimit = 100;
const maxResolveCandidates = 10_000;

export type AgentThreadRequest = {
  action?: "list" | "read" | "resolve" | "create" | "rename" | "send";
  query?: string;
  limit?: number;
  offset?: number;
  threadId?: string;
  title?: string;
  prompt?: string;
  cwd?: string;
  createIfMissing?: boolean;
  lookupMode?: "complete" | "state_db";
  sandbox?: CodexTurnSandbox;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  imagePaths?: string[];
  sourceThreadId?: string;
  sourceAgentType?: AgentThreadSourceType;
  responsePolicy?: AgentResponsePolicy;
  responseInstruction?: string;
  inReplyToRequestId?: string;
  result?: string;
  nextAction?: string;
  messageProcessing?: {
    requirementId?: string;
    outcome?: "handoff";
    targetAgentType?: AgentThreadSourceType;
    planId?: string;
    planTitle?: string;
  };
};

export type AgentThreadSourceType =
  | "primary_persona"
  | "message_processing"
  | "plan_secretary"
  | "plan_agent"
  | "agent";

export type AgentThreadSummary = {
  id: string;
  title: string;
  updatedAt: string;
  cwd?: string;
  archived?: boolean;
};

export type AgentThreadDriver = {
  list?: (params: {
    query: string;
    limit: number;
    offset: number;
    allowedWorkspaces: string[];
    stateDbOnly?: boolean;
  }) => Promise<AgentThreadSummary[]>;
  read: (threadId: string) => Promise<unknown>;
  create: (params: {
    title: string;
    prompt: string;
    cwd: string;
    developerInstructions: string;
    sandbox: CodexTurnSandbox;
    onCreationStage?: (state: "thread_created" | "naming" | "initial_turn", threadId: string) => void;
  }) => Promise<CodexThreadCreateResult>;
  rename?: (params: { threadId: string; title: string; cwd: string }) => Promise<AgentThreadSummary>;
  send: (params: {
    threadId: string;
    prompt: string;
    cwd: string;
    sandbox: CodexTurnSandbox;
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    imagePaths?: string[];
  }) => Promise<void | {
    threadId: string;
    action: "started" | "steered";
    openedThread: boolean;
    transport: "desktop-ipc";
    warning?: string;
  }>;
};

export type AgentThreadRequestOptions = {
  allowedWorkspaces: string[];
  defaultWorkspace?: string;
  sessionIndexPath?: string;
  agentRequests?: AgentRequestStore;
  onMessageProcessingHandoff?: (event: {
    requirementId: string;
    sourceThreadId: string;
    targetThreadId: string;
    targetAgentType: AgentThreadSourceType;
    planId?: string;
    planTitle?: string;
  }) => void | Promise<void>;
};

export type AgentThreadRequestResult = {
  statusCode: number;
  data: Record<string, unknown>;
};

class AgentThreadDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentThreadDeliveryError";
  }
}

export function agentThreadRequestFailureData(
  error: unknown,
  request: Pick<AgentThreadRequest, "action"> = {}
): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const missingField = /^Missing ([^.]+)\.$/.exec(message)?.[1];
  const relatedField = missingField
    || (message === "sourceAgentType requires sourceThreadId." ? "sourceThreadId" : undefined)
    || (/^responsePolicy /.test(message) ? "responsePolicy" : undefined)
    || (/^responseInstruction /.test(message) ? "responseInstruction" : undefined)
    || (/^result /.test(message) ? "result" : undefined)
    || (/^nextAction /.test(message) ? "nextAction" : undefined)
    || (/inReplyToRequestId/.test(message) ? "inReplyToRequestId" : undefined)
    || (/^Invalid threadId\.$/.test(message) ? "threadId" : undefined)
    || (/imagePaths|Image attachment|image attachment/.test(message) ? "imagePaths" : undefined)
    || (/^messageProcessing\.outcome /.test(message) ? "messageProcessing.outcome" : undefined)
    || (/verified message_processing source task/.test(message) ? "sourceAgentType" : undefined);
  const sourceVerification = /来源任务|sourceAgentType requires sourceThreadId|verified .* source task/i.test(message);
  const deliveryFailure = error instanceof AgentThreadDeliveryError;
  const validationFailure = Boolean(missingField)
    || Boolean(relatedField)
    || /^(Invalid |Unsupported |Workspace |No Codex workspaces)| must | requires |too long|must contain only|Agent request (?:not found|is not awaiting|already has)|Agent response /i.test(message);
  const stage = deliveryFailure
    ? "target_delivery"
    : sourceVerification
      ? "source_verification"
      : validationFailure
        ? "validation"
        : "request";
  return {
    action: request.action ?? null,
    status: "failed",
    message,
    error: {
      stage,
      ...(relatedField ? { field: relatedField } : {}),
      message,
      retryable: deliveryFailure
    }
  };
}

const defaultDriver: AgentThreadDriver = {
  list: listCodexThreads,
  read: readCodexThread,
  create: createCodexThread,
  rename: renameCodexThread,
  send: sendCodexThreadMessage
};

function normalizeSandbox(value: unknown, fallback: CodexTurnSandbox = "workspace-write"): CodexTurnSandbox {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return fallback;
}

function normalizeReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined;
}

const agentThreadSourceLabels: Record<AgentThreadSourceType, string> = {
  primary_persona: "主人格 Agent",
  message_processing: "消息处理 Agent",
  plan_secretary: "计划秘书 Agent",
  plan_agent: "计划执行 Agent",
  agent: "Agent"
};

const workspaceDeliveryPolicyLines = [
  "除非当前用户明确授权，禁止新建额外工作副本、稀疏检出、复制工程或旁路目录；工作区中的 AGENTS.md 如有更严格限制，以其为准。",
  "只有改动已经进入用户实际运行或验收的目标工作区，并完成适用的资源关联、构建或编译及运行验证，才能称为“已修复”或“可验收”；临时目录、其他分支、服务器提交或测试工程结果不能替代用户入口。",
  "PangHu 任务没有创建旁路工作副本的例外：只使用正式 Main、Release 和 Art；旧任务或历史记录中的隔离、稀疏、clean working copy 安排已经撤销。"
];

function standaloneWorkspacePolicyPrompt(rawPrompt: string): string {
  return [
    "[协作要求]",
    ...workspaceDeliveryPolicyLines,
    "",
    "[投递内容]",
    rawPrompt
  ].join("\n");
}

function imagePathsForDelivery(value: unknown, cwd: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("imagePaths must be an array.");
  if (value.length > 8) throw new Error("imagePaths supports at most 8 images per delivery.");
  const workspace = path.resolve(cwd);
  return [...new Set(value.map((item) => {
    const raw = String(item ?? "").trim();
    if (!raw || !path.isAbsolute(raw)) throw new Error("Every imagePaths item must be an absolute path.");
    const imagePath = path.resolve(raw);
    const relative = path.relative(workspace, imagePath);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Every imagePaths item must stay inside the target workspace.");
    }
    if (!/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(imagePath)) {
      throw new Error(`Unsupported image attachment type: ${path.extname(imagePath) || "no extension"}`);
    }
    const stat = fs.statSync(imagePath, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`Image attachment does not exist: ${imagePath}`);
    return imagePath;
  }))];
}

function normalizeAgentThreadSourceType(value: unknown): AgentThreadSourceType {
  const normalized = optionalText(value, "sourceAgentType", 40) || "agent";
  if (normalized in agentThreadSourceLabels) return normalized as AgentThreadSourceType;
  throw new Error("Invalid sourceAgentType. Expected primary_persona, message_processing, plan_secretary, plan_agent, or agent.");
}

const forbiddenAgentHandoffRoleMarkers = [
  "[消息处理 Agent 初始化]",
  "你是专职消息处理 Agent",
  "[计划协助会话恢复初始化]",
  "[计划秘书初始化]"
];

export function validateAgentThreadHandoffPromptForTest(prompt: string): void {
  if (/^\s*\[rabi:bind\b/im.test(prompt)
    || forbiddenAgentHandoffRoleMarkers.some((marker) => prompt.includes(marker))) {
    throw new Error("Agent-to-Agent handoff must contain only the newly composed handoff content, not another task's role initialization or complete injected prompt.");
  }
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
  return normalizePathForComparison(value);
}

function normalizeAgentResponsePolicy(value: unknown): AgentResponsePolicy {
  if (value === "required" || value === "none") return value;
  throw new Error("responsePolicy is required for Agent-to-Agent delivery and must be required or none.");
}

function agentResponseContractLines(preparation: AgentCommunicationPreparation): string[] {
  const sourceWorkspace = preparation.source.workspace || "<原发送任务的工作目录>";
  const lines = [
    "[Agent 回复合同]",
    `本次投递 deliveryId：${preparation.deliveryId}`,
    `是否要求回复：${preparation.responsePolicy === "required" ? "是" : "否"}`
  ];
  if (preparation.inReplyToRequestId) {
    lines.push(
      `本次消息已经正式回复请求：${preparation.inReplyToRequestId}`,
      `回复结果：${preparation.result}`,
      `下一步：${preparation.nextAction}`
    );
  }
  if (preparation.requestId) {
    lines.push(
      `必须回复的 requestId：${preparation.requestId}`,
      `需要回答：${preparation.responseInstruction}`,
      "回复必须通过 RabiRoute Agent 任务桥 POST /api/agent/threads，不能只写在 Codex 最终回答里。",
      `回复时填写 action=send、threadId=${preparation.source.threadId}、cwd=${sourceWorkspace}、sourceThreadId=当前任务完整 ID、sourceAgentType=当前 Agent 类型、inReplyToRequestId=${preparation.requestId}、result=本次结果、nextAction=下一步，并且仍须显式填写 responsePolicy=required 或 none。`,
      "如果新的下一步还需要对方完成后返回结果，填写 responsePolicy=required 和 responseInstruction；如果这次回复结束往返，填写 responsePolicy=none。",
      "本轮迭代结束仍未正式回复时，Manager 会在五分钟后向本任务投递提醒，并在后续每轮结束后继续检查。"
    );
  } else {
    lines.push("本次投递不要求回复；如果你之后向其它 Agent 投递消息，仍必须显式填写 responsePolicy=required 或 none。");
  }
  return lines;
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

async function readAgentThread(
  threadId: string,
  driver: AgentThreadDriver
): Promise<{ value: unknown; summary: AgentThreadSummary | null }> {
  const value = await driver.read(threadId);
  const summary = threadSummary(value);
  return { value, summary };
}

async function resolveAgentThreadSendSource(
  request: AgentThreadRequest,
  options: AgentThreadRequestOptions,
  driver: AgentThreadDriver
): Promise<{
  promptPrefix: string;
  source: {
    agentType: AgentThreadSourceType;
    agentLabel: string;
    threadId: string;
    threadName: string;
    workspace?: string;
  };
} | null> {
  const rawSourceThreadId = optionalText(request.sourceThreadId, "sourceThreadId", 80);
  if (!rawSourceThreadId) {
    if (request.sourceAgentType != null) {
      throw new Error("sourceAgentType requires sourceThreadId.");
    }
    return null;
  }

  const sourceThreadId = normalizeThreadId(rawSourceThreadId);
  const agentType = normalizeAgentThreadSourceType(request.sourceAgentType);
  let sourceThread: AgentThreadSummary | null = null;
  try {
    sourceThread = (await readAgentThread(sourceThreadId, driver)).summary;
  } catch (error) {
    if (!missingThreadError(error)) throw error;
  }
  if (!sourceThread || sourceThread.id !== sourceThreadId || sourceThread.archived) {
    throw new Error(`无法核对来源任务：${sourceThreadId}`);
  }

  const source = {
    agentType,
    agentLabel: agentThreadSourceLabels[agentType],
    threadId: sourceThreadId,
    threadName: sourceThread.title,
    ...(sourceThread.cwd ? { workspace: sourceThread.cwd } : {})
  };
  const promptPrefix = [
    "[Agent 任务投递来源]",
    `来源 Agent：${source.agentLabel}`,
    `来源任务：${source.threadName}`,
    `来源会话 ID：${source.threadId}`,
    source.workspace ? `来源工作目录：${source.workspace}` : undefined,
    "",
    "[协作要求]",
    ...proactiveCommunicationPolicyLines("internal"),
    ...workspaceDeliveryPolicyLines,
    ""
  ].filter((line): line is string => line !== undefined).join("\n");
  return { promptPrefix, source };
}

function missingThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|was not found|no rollout found/i.test(message);
}

async function createThread(
  request: AgentThreadRequest,
  options: AgentThreadRequestOptions,
  driver: AgentThreadDriver,
  requestedTitle = requiredText(request.title, "title", maxTitleInputLength),
  onCreationStage?: (state: "thread_created" | "naming" | "initial_turn", threadId: string) => void
): Promise<CodexThreadCreateResult> {
  const title = normalizeCodexThreadTitle(requestedTitle);
  const prompt = optionalText(request.prompt, "prompt", maxPromptLength);
  const cwd = resolveAgentThreadWorkspaceForTest(request.cwd, options);
  const sandbox = normalizeSandbox(request.sandbox);
  const createParams: Parameters<AgentThreadDriver["create"]>[0] = {
    title,
    prompt,
    cwd,
    developerInstructions: [
      "这是由 RabiRoute 会话管理层创建的独立 Codex 任务。",
      "严格按初始任务和用户后续消息处理，并遵守工作区中的 AGENTS.md 与任务明确引用的 Skill。",
      "运行沙箱权限不等于业务修改授权；没有明确授权时，只做读取、调查、证据整理和方案输出。",
      "开始工作前先读取当前任务的完整相关历史和已有结论，不得只看标题、摘要或最后一条消息。",
      ...proactiveCommunicationPolicyLines("internal"),
      ...workspaceDeliveryPolicyLines,
      "多步任务开始后要让当前任务中的人看得出你准备做什么；取得阶段结果、遇到风险或进入等待时主动更新，不要等别人追问。"
    ].join("\n"),
    sandbox
  };
  if (onCreationStage) createParams.onCreationStage = onCreationStage;
  return driver.create(createParams);
}

async function createThreadDurably(
  request: AgentThreadRequest,
  options: AgentThreadRequestOptions,
  driver: AgentThreadDriver,
  title: string,
  cwd: string
): Promise<CodexThreadCreateResult> {
  const rootDir = options.defaultWorkspace;
  if (!rootDir) return createThread({ ...request, title, cwd }, options, driver, title);
  return createCodexThreadWithReservation({
    rootDir,
    title,
    workspace: cwd,
    create: (onStage) => createThread({ ...request, title, cwd }, options, driver, title, onStage)
  });
}

async function listThreads(
  query: string,
  limit: number,
  offset: number,
  allowedWorkspaces: string[],
  options: AgentThreadRequestOptions,
  driver: AgentThreadDriver,
  stateDbOnly = false
): Promise<AgentThreadSummary[]> {
  if (driver.list) {
    return driver.list({
      query,
      limit,
      offset,
      allowedWorkspaces,
      ...(stateDbOnly ? { stateDbOnly: true } : {})
    });
  }
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
    const page = await listThreads(
      query,
      limit + 1,
      offset,
      options.allowedWorkspaces,
      options,
      driver,
      request.lookupMode === "state_db"
    );
    const hasMore = page.length > limit;
    const threads = page.slice(0, limit);
    return {
      statusCode: 200,
      data: { action, query, offset, threads, nextOffset: hasMore ? offset + threads.length : null }
    };
  }

  if (action === "read") {
    const threadId = normalizeThreadId(request.threadId);
    const thread = await readAgentThread(threadId, driver);
    return {
      statusCode: 200,
      data: { action, threadId, thread: thread.value }
    };
  }

  if (action === "resolve") {
    const rawThreadId = optionalText(request.threadId, "threadId", 80);
    const fallbackTitle = !isCodexTaskId(rawThreadId) ? rawThreadId : "";
    const title = requiredText(request.title || fallbackTitle, "title", maxTitleInputLength);
    const requestedWorkspace = resolveAgentThreadWorkspaceForTest(request.cwd, options);
    let resolution: CodexSessionResolution<AgentThreadSummary>;
    try {
      resolution = await resolveCodexSession({
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
          driver,
          request.lookupMode === "state_db"
        ),
        create: () => createThreadDurably(request, options, driver, title, requestedWorkspace)
      });
    } catch (error) {
      if (!(error instanceof CodexThreadCreationBlockedError)) throw error;
      return {
        statusCode: 409,
        data: {
          action,
          resolution: error.reservation.state,
          message: error.message,
          reservation: error.reservation
        }
      };
    }

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
    const title = normalizeCodexThreadTitle(requiredText(request.title, "title", maxTitleInputLength));
    const cwd = resolveAgentThreadWorkspaceForTest(request.cwd, options);
    let resolution: CodexSessionResolution<AgentThreadSummary>;
    try {
      resolution = await resolveCodexSession({
        title,
        cwd,
        createIfMissing: true
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
        list: ({ title: query, cwd: requestedWorkspace }) => listThreads(
          query,
          maxResolveCandidates,
          0,
          [requestedWorkspace],
          options,
          driver,
          true
        ),
        create: () => createThreadDurably(request, options, driver, title, cwd)
      });
    } catch (error) {
      if (!(error instanceof CodexThreadCreationBlockedError)) throw error;
      return {
        statusCode: 409,
        data: {
          action,
          resolution: error.reservation.state,
          message: error.message,
          reservation: error.reservation,
          sandbox
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
          candidates: resolution.candidates,
          sandbox
        }
      };
    }
    if (resolution.kind === "archived") {
      return {
        statusCode: 409,
        data: {
          action,
          resolution: "archived",
          message: `同名 Codex Desktop 任务已归档，请恢复或改名后再创建：${title}`,
          thread: resolution.thread,
          sandbox
        }
      };
    }
    if (resolution.kind === "workspace-mismatch") {
      return {
        statusCode: 409,
        data: {
          action,
          resolution: "workspace-mismatch",
          message: `Codex Desktop task belongs to another workspace. Task: ${resolution.thread.cwd}; configured: ${cwd}`,
          thread: resolution.thread,
          sandbox
        }
      };
    }
    if (resolution.kind === "missing") {
      return {
        statusCode: 404,
        data: { action, resolution: "missing", message: `没有找到或创建 Codex Desktop 任务：${title}`, sandbox }
      };
    }
    return {
      statusCode: resolution.kind === "created" ? 201 : 200,
      data: { action, resolution: resolution.kind, thread: resolution.thread, sandbox }
    };
  }

  if (action === "rename") {
    const threadId = normalizeThreadId(request.threadId);
    const title = normalizeCodexThreadTitle(requiredText(request.title, "title", maxTitleInputLength));
    const cwd = resolveAgentThreadWorkspaceForTest(request.cwd, options);
    if (!driver.rename) throw new Error("Agent thread rename is not supported by this driver.");
    const thread = await driver.rename({ threadId, title, cwd });
    return { statusCode: 200, data: { action, thread } };
  }

  if (action === "send") {
    const threadId = normalizeThreadId(request.threadId);
    const rawPrompt = requiredText(request.prompt, "prompt", maxPromptLength);
    const sendSource = await resolveAgentThreadSendSource(request, options, driver);
    if (sendSource) {
      if (sendSource.source.threadId === threadId) {
        throw new Error("Agent-to-Agent handoff source and target task must be different.");
      }
      validateAgentThreadHandoffPromptForTest(rawPrompt);
    }
    const cwd = resolveAgentThreadWorkspaceForTest(request.cwd, options);
    const sandbox = normalizeSandbox(request.sandbox);
    const model = optionalText(request.model, "model", 120) || undefined;
    const reasoningEffort = normalizeReasoningEffort(request.reasoningEffort);
    const imagePaths = imagePathsForDelivery(request.imagePaths, cwd);
    const messageProcessing = request.messageProcessing;
    let agentCommunication: AgentCommunicationPreparation | undefined;
    if (sendSource) {
      const responsePolicy = normalizeAgentResponsePolicy(request.responsePolicy);
      if (messageProcessing && responsePolicy !== "required") {
        throw new Error("messageProcessing handoff requires responsePolicy=required.");
      }
      const responseInstruction = optionalText(request.responseInstruction, "responseInstruction", 4_000) || undefined;
      const inReplyToRequestId = optionalText(request.inReplyToRequestId, "inReplyToRequestId", 100) || undefined;
      const result = optionalText(request.result, "result", 12_000) || undefined;
      const nextAction = optionalText(request.nextAction, "nextAction", 4_000) || undefined;
      if ((responsePolicy === "required" || inReplyToRequestId) && !options.agentRequests) {
        throw new Error("Agent request tracking is unavailable for this Agent-to-Agent delivery.");
      }
      agentCommunication = options.agentRequests
        ? options.agentRequests.prepare({
            source: {
              threadId: sendSource.source.threadId,
              agentType: sendSource.source.agentType,
              threadName: sendSource.source.threadName,
              workspace: sendSource.source.workspace
            },
            target: {
              threadId,
              agentType: "agent",
              workspace: cwd
            },
            responsePolicy,
            responseInstruction,
            inReplyToRequestId,
            result,
            nextAction,
            messageProcessingRequirementId: messageProcessing?.requirementId,
            planId: messageProcessing?.planId
          })
        : {
            deliveryId: `untracked-${Date.now()}`,
            responsePolicy,
            responseInstruction,
            inReplyToRequestId,
            result,
            nextAction,
            source: {
              threadId: sendSource.source.threadId,
              agentType: sendSource.source.agentType,
              threadName: sendSource.source.threadName,
              workspace: sendSource.source.workspace
            },
            target: { threadId, agentType: "agent", workspace: cwd }
          };
    }
    const prompt = sendSource && agentCommunication
      ? `${sendSource.promptPrefix}${agentResponseContractLines(agentCommunication).join("\n")}\n\n[投递内容]\n${rawPrompt}`
      : standaloneWorkspacePolicyPrompt(rawPrompt);
    let messageProcessingEvent: {
      requirementId: string;
      sourceThreadId: string;
      targetThreadId: string;
      targetAgentType: AgentThreadSourceType;
      planId?: string;
      planTitle?: string;
    } | undefined;
    if (messageProcessing != null) {
      if (!sendSource || sendSource.source.agentType !== "message_processing") {
        throw new Error("messageProcessing handoff requires a verified message_processing source task.");
      }
      const requirementId = requiredText(messageProcessing.requirementId, "messageProcessing.requirementId", 300);
      if (messageProcessing.outcome !== "handoff") {
        throw new Error("messageProcessing.outcome must be handoff for Agent thread delivery.");
      }
      messageProcessingEvent = {
        requirementId,
        sourceThreadId: sendSource.source.threadId,
        targetThreadId: threadId,
        targetAgentType: normalizeAgentThreadSourceType(requiredText(messageProcessing.targetAgentType, "messageProcessing.targetAgentType", 40)),
        planId: optionalText(messageProcessing.planId, "messageProcessing.planId", 300) || undefined,
        planTitle: optionalText(messageProcessing.planTitle, "messageProcessing.planTitle", 500) || undefined
      };
    }
    const delivery = { threadId, prompt, cwd, sandbox } as Parameters<AgentThreadDriver["send"]>[0];
    if (model) delivery.model = model;
    if (reasoningEffort) delivery.reasoningEffort = reasoningEffort;
    if (imagePaths.length) delivery.imagePaths = imagePaths;
    let acceptedDelivery: Awaited<ReturnType<AgentThreadDriver["send"]>>;
    try {
      acceptedDelivery = await driver.send(delivery);
    } catch (error) {
      if (agentCommunication && options.agentRequests) options.agentRequests.abort(agentCommunication);
      throw new AgentThreadDeliveryError(error instanceof Error ? error.message : String(error));
    }
    const acceptedReceipt = acceptedDelivery && typeof acceptedDelivery === "object"
      ? acceptedDelivery
      : undefined;
    let messageProcessingWarning: string | undefined;
    let agentRequestWarning: string | undefined;
    let committedAgentRequest: ReturnType<AgentRequestStore["commit"]> | undefined;
    if (agentCommunication && options.agentRequests) {
      try {
        committedAgentRequest = options.agentRequests.commit(agentCommunication, {
          action: acceptedReceipt?.action,
          transport: acceptedReceipt?.transport
        });
      } catch (error) {
        agentRequestWarning = `Agent delivery was accepted, but request tracking failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (messageProcessingEvent && options.onMessageProcessingHandoff) {
      try {
        await options.onMessageProcessingHandoff(messageProcessingEvent);
      } catch (error) {
        messageProcessingWarning = `Agent handoff was accepted, but the message-processing board update failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return {
      statusCode: 202,
      data: {
        action,
        ok: !messageProcessingWarning && !agentRequestWarning,
        threadId,
        status: messageProcessingWarning || agentRequestWarning ? "delivered_tracking_failed" : "delivered",
        delivery: {
          status: "delivered",
          targetThreadId: threadId,
          acceptedBy: "codex_desktop_owner",
          action: acceptedReceipt?.action ?? "accepted",
          transport: acceptedReceipt?.transport ?? "desktop-ipc",
          ...(acceptedReceipt ? { openedThread: acceptedReceipt.openedThread } : {}),
          ...(acceptedReceipt?.warning ? { warning: acceptedReceipt.warning } : {})
        },
        sandbox,
        model,
        reasoningEffort,
        ...(sendSource ? { source: sendSource.source } : {}),
        ...(agentCommunication ? {
          communication: {
            deliveryId: agentCommunication.deliveryId,
            responsePolicy: agentCommunication.responsePolicy,
            ...(agentCommunication.requestId ? {
              requestId: agentCommunication.requestId,
              requestStatus: committedAgentRequest?.request?.status ?? "tracking_failed"
            } : {}),
            ...(agentCommunication.inReplyToRequestId ? {
              inReplyToRequestId: agentCommunication.inReplyToRequestId,
              responseStatus: committedAgentRequest?.repliedRequest?.status ?? "tracking_failed"
            } : {})
          }
        } : {}),
        ...(messageProcessing ? { messageProcessing } : {}),
        ...(messageProcessingEvent ? {
          handoff: {
            status: messageProcessingWarning ? "tracking_failed" : "recorded",
            requirementId: messageProcessingEvent.requirementId,
            targetAgentType: messageProcessingEvent.targetAgentType,
            targetThreadId: messageProcessingEvent.targetThreadId,
            ...(messageProcessingWarning ? {
              error: {
                stage: "message_processing_tracking",
                message: messageProcessingWarning,
                retryable: true
              }
            } : {})
          }
        } : {}),
        ...((messageProcessingWarning || agentRequestWarning) ? {
          warning: [messageProcessingWarning, agentRequestWarning].filter(Boolean).join(" ")
        } : {})
      }
    };
  }

  throw new Error("Unsupported Agent thread action. Expected list, read, resolve, create, rename, or send.");
}
