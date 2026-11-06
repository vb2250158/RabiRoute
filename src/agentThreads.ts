import {agentNativeFunction,withAgentManagerInvocation,type AgentManagerOperationInvoker} from './agentAdapters/managerInvocation.js';
import {isDshSessionId} from './shared/dshSessionIdentity.js';
import { renderAgentReplyParameters } from "./agentRequests/replyParameters.js";
import { executeEndpointAgentDelivery, type EndpointDeliveryOptions, type PreparedEndpointDelivery, type EndpointDeliveryReceipt } from "./agentRequests/endpointDelivery.js";
import { agentDeliveryPromptHash } from "./agentRequests/store.js";
export { executeEndpointOnOwner } from "./agentRequests/ownerExecution.js";
import { AgentReplyStateError } from "./agentRequests/replyError.js";
import { AgentThreadContractError, callerAgentDeliveryId, normalizeAgentThreadSourceType, type AgentThreadSourceType } from "./agentRequests/requestValidation.js";
export type { AgentThreadSourceType } from "./agentRequests/requestValidation.js";
import { promptConfirmsDelivery } from "./shared/deliveryIdentity.js";
import type { AgentInstanceBinding } from "./shared/agentInstance.js";
import { randomUUID } from "node:crypto";
import { recoverAgentResponseDeliveryFromRollout } from "./agentRequests/deliveryRecovery.js";
import { renderAgentResponseContent } from "./agentRequests/responseContent.js";
import fs from "node:fs";
import path from "node:path";
import {type CodexThreadCreateResult,type CodexTurnSandbox} from "./agentAdapters/codexContracts.js";
import { isCodexTaskId } from "./codexTaskIdentity.js";
import type { AgentRequestEndpoint } from "./agentRequests/endpoint.js";

import {
  resolveCodexSession,
  type CodexSessionResolution
} from "./agentAdapters/codexNative.js";

import {
  CodexThreadCreationBlockedError,
  createCodexThreadWithReservation
} from "./codexThreadCreationReservations.js";

import { normalizeCodexThreadTitle } from "./shared/codexThreadTitle.js";
import { proactiveCommunicationPolicyLines } from "./shared/agentCommunicationPolicy.js";
import type { CodexReasoningEffort } from "./shared/gatewayConfigModel.js";

import {
  isAgentThreadCapableAdapter,
  type PlanAssistantAgentType
} from "./shared/agentAdapterCapabilities.js";

import { normalizePathForComparison } from "./shared/pathPolicy.js";
import { parseAgentAdapterType, type AgentAdapterType } from "./agentAdapters/types.js";
import { agentAdapterSupportsReceiptRecovery } from "./shared/agentAdapterCapabilities.js";
import {
  agentIdentityForMessageSource,
  normalizeRabiDeliveryBlock,
  renderRabiDelivery,
  renderRabiDeliveryContent,
  type RabiMessageSource
} from "./shared/rabiMessage.js";
import {
  AgentRequestStore,
  type AgentCommunicationPreparation,
  type AgentResponsePolicy
} from "./agentRequests/store.js";

const createCodexThread=agentNativeFunction<import("./agentAdapters/codexContracts.js").CodexNativeOperations["createCodexThread"]>("codex","createCodexThread");
const listCodexThreads=agentNativeFunction<import("./agentAdapters/codexContracts.js").CodexNativeOperations["listCodexThreads"]>("codex","listCodexThreads");
const readCodexThread=agentNativeFunction<import("./agentAdapters/codexContracts.js").CodexNativeOperations["readCodexThread"]>("codex","readCodexThread");
const renameCodexThread=agentNativeFunction<import("./agentAdapters/codexContracts.js").CodexNativeOperations["renameCodexThread"]>("codex","renameCodexThread");
const sendCodexThreadMessage=agentNativeFunction<import("./agentAdapters/codexContracts.js").CodexNativeOperations["sendCodexThreadMessage"]>("codex","sendCodexThreadMessage");
const codexDesktopDeliveryReceiptConfirmed=agentNativeFunction<import("./agentAdapters/codexContracts.js").CodexNativeOperations["codexDesktopDeliveryReceiptConfirmed"]>("codex","codexDesktopDeliveryReceiptConfirmed");
const openCodexDesktopThread=agentNativeFunction<import("./agentAdapters/codexContracts.js").CodexNativeOperations["openCodexDesktopThread"]>("codex","openCodexDesktopThread");
const listDshSessions=agentNativeFunction<typeof import("./plugins/io.rabiroute.agent.dsh/src/dshSessionBridge.js")["listDshSessions"]>("dsh","listDshSessions");
const readDshPrimaryBindingAsync=agentNativeFunction<typeof import("./plugins/io.rabiroute.agent.dsh/src/dshSessionBridge.js")["readDshPrimaryBindingAsync"]>("dsh","readDshPrimaryBindingAsync");
const openDshSession=agentNativeFunction<typeof import("./plugins/io.rabiroute.agent.dsh/src/dshSessionBridge.js")["openDshSession"]>("dsh","openDshSession");
const readDshSession=agentNativeFunction<typeof import("./plugins/io.rabiroute.agent.dsh/src/dshSessionBridge.js")["readDshSession"]>("dsh","readDshSession");
const renameDshSession=agentNativeFunction<typeof import("./plugins/io.rabiroute.agent.dsh/src/dshSessionBridge.js")["renameDshSession"]>("dsh","renameDshSession");
const resolveDshSession=agentNativeFunction<typeof import("./plugins/io.rabiroute.agent.dsh/src/dshSessionBridge.js")["resolveDshSession"]>("dsh","resolveDshSession");
const sendDshSessionMessage=agentNativeFunction<typeof import("./plugins/io.rabiroute.agent.dsh/src/dshSessionBridge.js")["sendDshSessionMessage"]>("dsh","sendDshSessionMessage");
const readAntigravitySession=agentNativeFunction<typeof import("./plugins/io.rabiroute.agent.antigravity/src/antigravitySessionStore.js")["readAntigravitySession"]>("antigravity","readAntigravitySession");
const listWorkbuddyThreads=agentNativeFunction<typeof import("./plugins/io.rabiroute.agent.workbuddy/src/workbuddyThreads.js")["listWorkbuddyThreads"]>("workbuddy","listWorkbuddyThreads");
const readWorkbuddyThread=agentNativeFunction<typeof import("./plugins/io.rabiroute.agent.workbuddy/src/workbuddyThreads.js")["readWorkbuddyThread"]>("workbuddy","readWorkbuddyThread");
const sendWorkbuddyThreadMessage=agentNativeFunction<typeof import("./plugins/io.rabiroute.agent.workbuddy/src/workbuddyThreads.js")["sendWorkbuddyThreadMessage"]>("workbuddy","sendWorkbuddyThreadMessage");

const maxThreadIdLength = 512;
const maxQueryLength = 240;
const maxTitleInputLength = 200_000;
const maxPromptLength = 200_000;
const maxListLimit = 200;
const defaultListLimit = 100;
const maxResolveCandidates = 10_000;

export type AgentThreadRequest = {
  /** Explicit local owner selection; remote requests use instanceBinding. */
  agentTargetId?: string;
  instanceBinding?: AgentInstanceBinding;
  /** Original business ledger location for a formal cross-PC reply; never grants source authority. */
  ledgerOwnerDeviceId?: string;
  action?: "list" | "read" | "reconcile_delivery" | "open" | "resolve" | "create" | "rename" | "send";
  agentAdapter?: AgentAdapterType;
  query?: string;
  limit?: number;
  offset?: number;
  threadId?: string;
  deliveryId?: string;
  title?: string;
  prompt?: string;
  grokBotDelivery?: { deliveryType: "private" | "group"; sendMode: "direct" | "identity"; senderAgentId?: string };
  cwd?: string;
  createIfMissing?: boolean;
  lookupMode?: "complete" | "state_db";
  sandbox?: CodexTurnSandbox;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  imagePaths?: string[];
  dshBaseUrl?: string;
  dshAgentPreset?: string;
  dshDeliveryMode?: "queue" | "steer";
  messageSource?: RabiMessageSource;
  contextBlocks?: string[];
  controlBlocks?: string[];
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

export type AgentThreadSummary = {
  id: string;
  title: string;
  updatedAt?: string;
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
    /**
     * How the prompt reached the host. `agentapi` is Antigravity's own CLI
     * subcommand channel, which is neither the desktop IPC pipe nor a plain
     * HTTP session endpoint.
     */
    transport: "desktop-ipc" | "http" | "agentapi";
    warning?: string;
  }>;
};

/** Connection/request attribution captured at ingress; this does not prove a source task owner. */
export type AgentThreadRemoteSource = {
  nodeId: string;
  agentId?: string;
  provider?: AgentAdapterType;
  sessionId?: string;
  sessionName?: string;
  workspace?: string;
  authorizationIncarnation?: string;
};

export type AgentThreadRequestOptions = {
  invokeAgentOperation?: AgentManagerOperationInvoker;
  getProviders?: () => readonly import("@rabiroute/plugin-sdk").AgentAdapterProvider[];
  /** Trusted SDK metadata creation context; never sourced from the request body. */
  creationIntent?: { key: string; hash: string };
  creationRootDir?: string;
  endpointDelivery?: EndpointDeliveryOptions;
  /** Trusted entry-point snapshot of explicit execution fields before managed defaults are applied. */
  callerExecutionOptions?: EndpointDeliveryOptions["callerExecutionOptions"];
  /** Original HTTP admission fence, captured by the Manager route, never by request JSON. */
  requestAuthority?: () => void;
  remoteSource?: AgentThreadRemoteSource;
  /** Build an already-addressed return endpoint from ingress metadata, without source qualification. */
  remoteEndpoint?: (nodeId: string, agentId: string, sessionId: string, provider?: string, authorizationIncarnation?: string) => AgentRequestEndpoint;
  onChatHistoryDelivery?: (request: AgentThreadRequest, result: AgentThreadRequestResult) => Promise<void>;
  allowedWorkspaces: string[];
  defaultWorkspace?: string;
  codexDefaults?: { model?: string; reasoningEffort?: CodexReasoningEffort };
  dshBaseUrl?: string;
  dshAgentPreset?: string;
  openCodexThread?: (threadId: string) => Promise<void>;
  openDshSession?: (sessionId: string, baseUrl: string) => Promise<void>;
  sessionIndexPath?: string;
  agentRequests?: AgentRequestStore;
  confirmCodexDelivery?: (threadId: string, deliveryId: string) => boolean | Promise<boolean>;
  /** Legacy caller metadata hook; delivery never invokes it to qualify a source. */
  readGrokBotSource?: (sessionId: string) => Promise<{ sessionId: string; sessionName: string } | null>;
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

function missingThreadNextAction(agentAdapter: string): string {
  return '在原目标实例/Agent绑定内，POST /api/agent/threads，按名称搜索正文 ' + JSON.stringify({ action: 'list', agentAdapter, query: '<会话名称>', limit: 20, offset: 0 })
    + '；或 query 留空列出可发现会话，按返回 updatedAt 核对最近活动并沿 nextOffset 分页。核对完整 threadId、名称和工作目录后读取原会话；保留原 deliveryId/actual，不自动创建替代会话或重发未确认消息。';
}

export function agentThreadRequestFailureData(error: unknown, request: Pick<AgentThreadRequest, "action" | "sourceAgentType"> = {}): Record<string, unknown> {
  const failure = agentThreadRequestFailureDataWithoutCaller(error, request);
  const callerDeliveryId = (error as { callerDeliveryId?: unknown } | null)?.callerDeliveryId;
  return typeof callerDeliveryId === "string" ? { ...failure, callerDeliveryId } : failure;
}

/** Validate a remote create's initial delivery before creating native metadata. Uses the same field normalizers as local create/send. */
export function normalizeAgentThreadInitialDeliveryRequest(request: AgentThreadRequest): AgentThreadRequest {
  const prompt = optionalText(request.prompt, "prompt", maxPromptLength);
  const title = normalizeCodexThreadTitle(requiredText(request.title, "title", maxTitleInputLength));
  const sandbox = normalizeSandbox(request.sandbox);
  const model = optionalText(request.model, "model", 120) || undefined;
  const reasoningEffort = normalizeReasoningEffort(request.reasoningEffort);
  const responsePolicy = request.responsePolicy === undefined ? "none" : normalizeAgentResponsePolicy(request.responsePolicy);
  if (request.messageProcessing && responsePolicy !== "required") throw new Error("messageProcessing handoff requires responsePolicy=required.");
  if (request.imagePaths != null && !Array.isArray(request.imagePaths)) throw new Error("imagePaths must be an array.");
  if (request.imagePaths?.length) throw new Error("Endpoint delivery does not transfer local attachment paths.");
  return { ...request, title, prompt, sandbox: request.sandbox === undefined ? undefined : sandbox, model, reasoningEffort, responsePolicy,
    deliveryId: callerAgentDeliveryId(request.deliveryId), sourceThreadId: request.sourceThreadId,
    sourceAgentType: normalizeAgentThreadSourceType(request.sourceAgentType), messageSource: request.messageSource,
    contextBlocks: deliveryBlocks(request.contextBlocks, "contextBlocks"), controlBlocks: deliveryBlocks(request.controlBlocks, "controlBlocks"),
    inReplyToRequestId: optionalText(request.inReplyToRequestId, "inReplyToRequestId", 100) || undefined,
    responseInstruction: optionalText(request.responseInstruction, "responseInstruction", 4_000) || undefined,
    result: optionalText(request.result, "result", 12_000) || undefined, nextAction: optionalText(request.nextAction, "nextAction", 4_000) || undefined };
}

function agentThreadRequestFailureDataWithoutCaller(
  error: unknown,
  request: Pick<AgentThreadRequest, "action" | "sourceAgentType"> = {}
): Record<string, unknown> {
  if (["AGENT_REQUEST_STORE_UNAVAILABLE", "AGENT_REQUEST_COMMIT_UNKNOWN"].includes(String((error as { code?: unknown })?.code))) {
    const failure = error as { code: string; commitState?: string };
    const unknown = failure.commitState === "unknown";
    const message = error instanceof Error ? error.message : String(error);
    return { action: request.action ?? null, status: "failed", message, ...(unknown ? { uncertain: true } : {}),
      error: { stage: "request_store", code: failure.code, message, commitState: unknown ? "unknown" : "not_started", retryable: false,
        nextAction: "Read the original request or delivery by its existing ID after the owner is restored; do not create a replacement intent." } };
  }
  if (error instanceof AgentThreadContractError) {
    return { action: request.action ?? null, status: "failed", message: error.message, errorCode: error.code, field: error.field, repair: error.repair,
      error: { stage: error.stage, field: error.field, code: error.code, message: error.message, repair: error.repair, retryable: false } };
  }
  const originalMessage = error instanceof Error ? error.message : String(error);
  const archivedTargetIsMissing = request.action === "send"
    && Boolean(request.sourceAgentType)
    && /(?:Codex Desktop task is archived|Codex Desktop task .*archived|任务已归档|会话已归档)/i.test(originalMessage);
  const message = archivedTargetIsMissing ? "会话任务不存在。" : originalMessage;
  const missingField = /^Missing ((?:messageSource\.)?(?:agentAdapter|sessionId|sessionName)|[^.]+)\.$/.exec(message)?.[1];
  const relatedField = missingField
    || (/^Invalid messageSource\.agentAdapter/.test(message) ? "messageSource.agentAdapter" : undefined)
    || (/messageSource\.sessionId/.test(message) ? "messageSource.sessionId" : undefined)
    || (message === "sourceAgentType requires sourceThreadId." ? "sourceThreadId" : undefined)
    || (/^responsePolicy /.test(message) ? "responsePolicy" : undefined)
    || (/^responseInstruction /.test(message) ? "responseInstruction" : undefined)
    || (/^result /.test(message) ? "result" : undefined)
    || (/^nextAction /.test(message) ? "nextAction" : undefined)
    || (/inReplyToRequestId/.test(message) ? "inReplyToRequestId" : undefined)
    || (/^Invalid threadId\.$/.test(message) ? "threadId" : undefined)
    || (/imagePaths|Image attachment|image attachment/.test(message) ? "imagePaths" : undefined)
    || (/^messageProcessing\.outcome /.test(message) ? "messageProcessing.outcome" : undefined)
    || (/verified message_processing source task/.test(originalMessage) ? "sourceAgentType" : undefined);
  const sourceVerification = /来源任务|messageSource\.sessionId|sourceAgentType requires sourceThreadId|verified .* source task/i.test(originalMessage);
  const deliveryFailure = error instanceof AgentThreadDeliveryError;
  const validationFailure = Boolean(missingField)
    || Boolean(relatedField)
    || /^(Invalid |Unsupported |Workspace |No Codex workspaces)| must | requires |too long|must contain only|Agent request (?:not found|is not awaiting|already has)|Agent response /i.test(originalMessage);
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
      retryable: deliveryFailure,
      ...(error instanceof AgentReplyStateError ? {
        code: error.code, reason: error.reason, requestId: error.requestId,
        currentState: error.currentState, expectedState: error.expectedState,
        commitState: error.commitState, retryable: error.retryable, nextAction: error.nextAction
      } : {})
    }
  };
}

async function dshBaseUrlFor(options?: AgentThreadRequestOptions): Promise<string> {
  return options?.dshBaseUrl?.trim() || (await readDshPrimaryBindingAsync())?.baseUrl || "";
}

const defaultDriver: AgentThreadDriver = {
  list: listCodexThreads,
  read: async (threadId) => isDshSessionId(threadId)
    ? readDshSession(threadId, await dshBaseUrlFor())
    : readCodexThread(threadId),
  create: createCodexThread,
  rename: renameCodexThread,
  send: async (params) => isDshSessionId(params.threadId)
    ? sendDshSessionMessage({
        sessionId: params.threadId,
        prompt: params.prompt,
        cwd: params.cwd,
        baseUrl: await dshBaseUrlFor(),
        imagePaths: params.imagePaths
      })
    : sendCodexThreadMessage(params)
};

function normalizeSandbox(value: unknown, fallback: CodexTurnSandbox = "workspace-write"): CodexTurnSandbox {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return fallback;
}

function normalizeReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra"
    ? value
    : undefined;
}

const agentThreadSourceLabels: Record<AgentThreadSourceType, string> = {
  primary_persona: "主角色 Agent",
  message_processing: "消息处理 Agent",
  plan_secretary: "计划秘书 Agent",
  plan_agent: "计划执行 Agent",
  agent: "Agent"
};

const commonWorkspaceDeliveryPolicyLines = [
  "只在目标工作区执行，并遵守工作区 AGENTS.md。",
  "改动进入目标工作区并完成适用验证后，才能报告已修复或可验收。"
];

function deliveryBlocks(value: unknown, name: "contextBlocks" | "controlBlocks"): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  if (value.length > 32) throw new Error(`${name} supports at most 32 blocks.`);
  return value.map((item, index) => {
    const block = requiredText(item, `${name}[${index}]`, maxPromptLength);
    return normalizeRabiDeliveryBlock(block, `${name}[${index}]`);
  });
}

function standaloneWorkspacePolicyPrompt(
  rawPrompt: string,
  messageSource: RabiMessageSource | undefined,
  cwd: string,
  contextBlocks: readonly string[] = [],
  controlBlocks: readonly string[] = [],
  deliveryId?: string
): string {
  if (!messageSource) return [
    ...(deliveryId ? ['[投递编号]\ndeliveryId: ' + deliveryId] : []),
    renderRabiDeliveryContent({ messageContent: rawPrompt, contextBlocks, controlBlocks })
  ].join('\n\n');
  return renderRabiDelivery({
    messageSource,
    messageContent: rawPrompt,
    deliveryId,
    contextBlocks,
    controlBlocks,
    escapeMessageContentHeaders: (messageSource.type === "agent" || messageSource.type === "agent_hook")
  });
}

function imagePathsForDelivery(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("imagePaths must be an array.");
  return [...new Set(value.map((item) => {
    const raw = String(item ?? "").trim();
    if (!raw || !path.isAbsolute(raw)) throw new Error("Every imagePaths item must be an absolute path.");
    const imagePath = path.resolve(raw);
    if (!/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(imagePath)) {
      throw new Error(`Unsupported image attachment type: ${path.extname(imagePath) || "no extension"}`);
    }
    const stat = fs.statSync(imagePath, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`Image attachment does not exist: ${imagePath}`);
    return imagePath;
  }))];
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
  const threadId = requiredText(value, "threadId", maxThreadIdLength);
  if (!isCodexTaskId(threadId) && !isDshSessionId(threadId)) {
    throw new Error("Invalid threadId.");
  }
  return threadId;
}


type ThreadCapableAgentAdapter = PlanAssistantAgentType;

function inferredThreadAdapter(threadId: string): ThreadCapableAgentAdapter | undefined {
  return isDshSessionId(threadId) ? "dsh" : undefined;
}

/**
 * Delivery receipt attribution for an adapter.
 *
 * This used to be a binary `dsh ? ... : codex` branch, which quietly reported
 * every non-DSH adapter as Codex. Antigravity delivers through the host's own
 * `agy agentapi` CLI, so calling it `codex_desktop_owner`/`desktop-ipc` would
 * have written a false audit trail. Keep the table adapter-keyed so a new
 * adapter adds one row instead of silently inheriting Codex's identity.
 */
function deliveryReceiptAttribution(agentAdapter: ThreadCapableAgentAdapter): {
  acceptedBy: string;
  transport: "desktop-ipc" | "http" | "agentapi";
} {
  switch (agentAdapter) {
    case "dsh":
      return { acceptedBy: "dsh_session_owner", transport: "http" };
    case "antigravity":
      return { acceptedBy: "antigravity_agentapi_owner", transport: "agentapi" };
    case "workbuddy":
      return { acceptedBy: "workbuddy_session_owner", transport: "http" };
    default:
      return { acceptedBy: "codex_desktop_owner", transport: "desktop-ipc" };
  }
}

function threadAgentAdapter(request: Pick<AgentThreadRequest, "agentAdapter" | "threadId">): ThreadCapableAgentAdapter {
  const rawAdapter = request.agentAdapter == null ? "" : String(request.agentAdapter);
  const explicit = rawAdapter ? parseAgentAdapterType(rawAdapter) : null;
  if (rawAdapter && !explicit) {
    throw new Error(`Invalid agentAdapter: ${rawAdapter}`);
  }
  if (explicit && !isAgentThreadCapableAdapter(explicit)) {
    throw new Error(`Agent thread operations are not supported for agentAdapter=${explicit}.`);
  }
  const rawThreadId = typeof request.threadId === "string" ? request.threadId.trim() : "";
  const inferred = inferredThreadAdapter(rawThreadId);
  if (explicit && inferred && explicit !== inferred) {
    throw new Error(`agentAdapter=${explicit} conflicts with threadId owner=${inferred}.`);
  }
  // A self-identifying id wins only when no adapter was named; otherwise Codex is
  // the historical default for callers that predate adapter tagging.
  return explicit || inferred || "codex";
}

async function readAgentThreadForAdapter(
  adapter: ThreadCapableAgentAdapter,
  threadId: string,
  options: AgentThreadRequestOptions,
  driver: AgentThreadDriver
): Promise<{ value: unknown; summary: AgentThreadSummary | null }> {
  if (driver !== defaultDriver) return readAgentThread(threadId, driver);
  const value = adapter === "dsh"
    ? await readDshSession(threadId, await dshBaseUrlFor(options))
    : adapter === "antigravity"
      ? await readAntigravitySession(threadId)
      : adapter === "workbuddy"
        ? await readWorkbuddyThread(threadId)
        : await readCodexThread(threadId);
  return { value, summary: threadSummary(value) };
}

async function listThreadsForAdapter(
  adapter: ThreadCapableAgentAdapter,
  query: string,
  limit: number,
  offset: number,
  allowedWorkspaces: string[],
  options: AgentThreadRequestOptions,
  driver: AgentThreadDriver,
  stateDbOnly = false
): Promise<AgentThreadSummary[]> {
  if (adapter === "dsh" && driver === defaultDriver) {
    return listDshSessions({
      baseUrl: await dshBaseUrlFor(options),
      query,
      limit,
      offset,
      allowedWorkspaces
    });
  }
  if (adapter === "workbuddy" && driver === defaultDriver) {
    return listWorkbuddyThreads({ query, limit, offset, allowedWorkspaces });
  }
  return listThreads(query, limit, offset, allowedWorkspaces, options, driver, stateDbOnly);
}
function canonicalWorkspace(value: string): string {
  return normalizePathForComparison(value);
}

function normalizeAgentResponsePolicy(value: unknown): AgentResponsePolicy {
  if (value === "required" || value === "none") return value;
  throw new Error("responsePolicy is required for Agent-to-Agent delivery and must be required or none.");
}


export function resolveAgentThreadWorkspaceForTest(
  requestedWorkspace: unknown,
  options: AgentThreadRequestOptions
): string {
  // A workspace is execution context, never an API authorization boundary.
  const requested = typeof requestedWorkspace === "string" && requestedWorkspace.trim()
    ? path.resolve(requestedWorkspace.trim())
    : path.resolve(options.defaultWorkspace?.trim() || process.cwd());
  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
    throw new Error(`Workspace does not exist or is not a directory: ${requested}`);
  }
  return requested;
}

function threadUpdatedAtSortKey(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
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
      if (!current || threadUpdatedAtSortKey(candidate.updatedAt) > threadUpdatedAtSortKey(current.updatedAt)) {
        latestById.set(candidate.id, candidate);
      }
    } catch {
      // Ignore incomplete or malformed JSONL records.
    }
  }
  return [...latestById.values()].sort((left, right) => threadUpdatedAtSortKey(right.updatedAt) - threadUpdatedAtSortKey(left.updatedAt));
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

export async function readAgentEndpointSummary(provider: AgentAdapterType, sessionId: string, options: AgentThreadRequestOptions): Promise<AgentThreadSummary> {
return withAgentManagerInvocation(options, async () => {

  const thread = await readAgentThreadForAdapter(threadAgentAdapter({ agentAdapter: provider }), sessionId, options, defaultDriver);
  if (!thread.summary) throw new Error("Exact endpoint owner metadata is unavailable.");
  return thread.summary;

});
}

function threadSummary(value: unknown): AgentThreadSummary | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.title !== "string") return null;
  return {
    id: item.id,
    title: item.title,
    ...(typeof item.updatedAt === "string" ? { updatedAt: item.updatedAt } : {}),
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

/** Source text is descriptive. Missing SDK display fields never qualify an invocation. */
function describeAgentThreadMessageSource(value: unknown, remote?: AgentThreadRemoteSource): RabiMessageSource | undefined {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (field: unknown, max = 500) => typeof field === "string" ? field.replace(/[\r\n\u2028\u2029]/g, " ").trim().slice(0, max) || undefined : undefined;
  const identity = (input: Record<string, unknown>, context?: AgentThreadRemoteSource) => {
    const provider = (typeof input.agentAdapter === "string" ? parseAgentAdapterType(input.agentAdapter) : undefined) ?? context?.provider;
    const sessionId = text(input.sessionId, 4096) ?? context?.sessionId;
    if (!provider || !sessionId) return undefined;
    const agentType = text(input.agentType, 80), workspace = text(input.workspace, 2000) ?? context?.workspace;
    return { agentAdapter: provider, sessionId, sessionName: text(input.sessionName) ?? context?.sessionName ?? sessionId,
      ...(agentType ? { agentType } : {}), ...(workspace ? { workspace } : {}) };
  };
  if (raw.type === "agent" || raw.type === "agent_hook" || raw.type === undefined) {
    const source = identity(raw, remote);
    return source ? { type: raw.type === "agent_hook" ? "agent_hook" : "agent", ...source } : undefined;
  }
  if (raw.type === "plan") {
    const planId = text(raw.planId, 300); if (!planId) return undefined;
    const sourceAgent = raw.sourceAgent && typeof raw.sourceAgent === "object" ? identity(raw.sourceAgent as Record<string, unknown>, remote) : undefined;
    return { type: "plan", planId, planName: text(raw.planName) ?? planId, ...(sourceAgent ? { sourceAgent } : {}) };
  }
  if (raw.type === "system") {
    const eventType = text(raw.eventType), eventId = text(raw.eventId); if (!eventType || !eventId) return undefined;
    return { type: "system", eventType, eventId, eventName: text(raw.eventName) ?? eventType,
      actorType: text(raw.actorType), actorName: text(raw.actorName), actorId: text(raw.actorId), routeName: text(raw.routeName), routeId: text(raw.routeId) };
  }
  if (raw.type === "message_adapter") {
    const messageAdapter = text(raw.messageAdapter,100), conversationType = text(raw.conversationType,100), conversationId = text(raw.conversationId,300), messageId = text(raw.messageId,300);
    const senderName = text(raw.senderName), senderId = text(raw.senderId,300);
    if (!messageAdapter || !conversationType || !conversationId || !messageId || !senderName && !senderId) return undefined;
    return { type: "message_adapter", messageAdapter, conversationType, conversationId, messageId, senderName, senderId,
      conversationName: text(raw.conversationName), messageGroupId: text(raw.messageGroupId,300), routeName: text(raw.routeName), routeId: text(raw.routeId) };
  }
  return undefined;
}

/** Record declared attribution and an existing return route without reading the source owner. */
function agentThreadSendAttribution(request: AgentThreadRequest, options: AgentThreadRequestOptions,
  messageSource: RabiMessageSource) {
  const identity = agentIdentityForMessageSource(messageSource), remote = options.remoteSource;
  const agentAdapter = identity?.agentAdapter ?? remote?.provider;
  const threadId = request.sourceThreadId ?? identity?.sessionId ?? remote?.sessionId;
  if (!agentAdapter || !threadId) return null;
  const agentType = normalizeAgentThreadSourceType(request.sourceAgentType);
  const agentLabel = Object.hasOwn(agentThreadSourceLabels, agentType) ? agentThreadSourceLabels[agentType] : agentType;
  const threadName = identity?.sessionName ?? remote?.sessionName ?? threadId;
  const workspace = identity?.workspace ?? remote?.workspace;
  const endpoint = remote && options.remoteEndpoint
    ? options.remoteEndpoint(remote.nodeId, remote.agentId ?? agentAdapter, threadId, agentAdapter, remote.authorizationIncarnation) : undefined;
  return { messageSource: messageSource.type === "agent" && !messageSource.agentType
    ? { ...messageSource, agentType: agentLabel } : messageSource,
    source: { agentAdapter, agentType, agentLabel,
    threadId, threadName, ...(workspace ? { workspace } : {}), ...(endpoint ? { endpoint } : {}),
    ...(remote ? { nodeId: remote.nodeId, agentId: remote.agentId } : {}) } };
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
  const rawPrompt = optionalText(request.prompt, "prompt", maxPromptLength);
  const cwd = resolveAgentThreadWorkspaceForTest(request.cwd, options);
  const prompt = rawPrompt
    ? standaloneWorkspacePolicyPrompt(
        rawPrompt,
        describeAgentThreadMessageSource(request.messageSource, options.remoteSource),
        cwd,
        deliveryBlocks(request.contextBlocks, "contextBlocks"),
        deliveryBlocks(request.controlBlocks, "controlBlocks")
      )
    : "";
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
      ...commonWorkspaceDeliveryPolicyLines,
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
  cwd: string,
  replacementForThreadId?: string
): Promise<CodexThreadCreateResult> {
  const rootDir = options.creationIntent ? options.creationRootDir : options.defaultWorkspace;
  if (!rootDir) return createThread({ ...request, title, cwd }, options, driver, title);
  return createCodexThreadWithReservation({
    rootDir,
    title,
    workspace: cwd,
    replacementForThreadId,
    callerIntent: options.creationIntent,
    confirmMissing: async () => {
      if (replacementForThreadId) return true;
      const matches = await listThreads(title, maxResolveCandidates, 0, [cwd], options, driver, true);
      const canonicalTitle = normalizeCodexThreadTitle(title);
      const canonicalCwd = canonicalWorkspace(cwd);
      return !matches.some((thread) => !thread.archived
        && normalizeCodexThreadTitle(thread.title) === canonicalTitle
        && (!thread.cwd || canonicalWorkspace(thread.cwd) === canonicalCwd));
    },
    create: (onStage) => createThread({ ...request, title, cwd }, options, driver, title, onStage)
  });
}

function isCodexDesktopTaskDeliveryTargetMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no-client-found|no rollout found for thread id|task was not found|thread not found/i.test(message);
}

async function createReplacementForMissingCodexDeliveryTarget(
  request: AgentThreadRequest,
  options: AgentThreadRequestOptions,
  driver: AgentThreadDriver,
  params: { threadId: string; title: string; cwd: string },
  deliveryError: unknown
): Promise<AgentThreadSummary | null> {
  if (!isCodexTaskId(params.threadId) || !isCodexDesktopTaskDeliveryTargetMissing(deliveryError)) return null;

  try {
    const current = threadSummary(await driver.read(params.threadId));
    if (current && !current.archived) return null;
  } catch (error) {
    if (!missingThreadError(error)) throw error;
  }

  const created = await createThreadDurably(
    { ...request, prompt: "" },
    options,
    driver,
    params.title,
    params.cwd,
    params.threadId
  );
  const replacement = threadSummary(created);
  if (!replacement) throw new Error("Replacement Codex Desktop task creation did not return a task.");
  return replacement;
}


async function reconcileOpenAgentRequestPartiesForReplacement(
  agentRequests: AgentThreadRequestOptions["agentRequests"] | undefined,
  previousThreadId: string,
  previousWorkspace: string,
  replacement: AgentThreadSummary
): Promise<void> {
  if (!agentRequests || replacement.id === previousThreadId) return;
  const previousCanonicalWorkspace = canonicalWorkspace(previousWorkspace);
  await agentRequests.reconcileOpenParties((party) => (
    party.threadId === previousThreadId
      && (!party.workspace || canonicalWorkspace(party.workspace) === previousCanonicalWorkspace)
      ? {
          ...party,
          threadId: replacement.id,
          threadName: replacement.title,
          workspace: replacement.cwd || previousWorkspace
        }
      : undefined
  ));
}

export function agentThreadDeliveryStateForTest(
  thread: unknown,
  deliveryId: string,
  rolloutReceiptConfirmed = false
): "accepted" | "in_progress" | "missing" {
  const value = thread as { turns?: { items?: { type?: string; content?: { text?: string }[] }[] }[] };
  const accepted = value?.turns?.some(turn => turn.items?.some(item => item.type === "userMessage"
    && Array.isArray(item.content)
    && promptConfirmsDelivery(item.content.map(part => part.text || "").join("\n"), deliveryId)));
  if (rolloutReceiptConfirmed || accepted) return "accepted";
  return (thread as { active?: unknown })?.active === true ? "in_progress" : "missing";
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
  const result = await withAgentManagerInvocation(options, () => executeAgentThreadRequest(request, options, driver));
  if (request.action === "send" && (request.messageSource?.type === "agent" || request.messageSource?.type === "agent_hook")
    && (!options.remoteSource || Boolean(result.data.source && result.data.messageSource))
    && ["delivered", "delivered_tracking_failed", "delivery_unconfirmed"].includes(String(result.data.status))) {
    const historyRequest = options.remoteSource && result.data.messageSource
      ? {
          ...request,
          sourceThreadId: (result.data.source as { threadId: string }).threadId,
          messageSource: result.data.messageSource as RabiMessageSource
        }
      : request;
    try { await options.onChatHistoryDelivery?.(historyRequest, result); }
    catch (error) {
      // The message may already be accepted. A history failure must never invite a resend.
      result.data.chatHistoryWarning = error instanceof Error ? error.message : String(error);
    }
  }
  return result;
}

async function executeAgentThreadRequest(
  request: AgentThreadRequest,
  options: AgentThreadRequestOptions,
  driver: AgentThreadDriver = defaultDriver
): Promise<AgentThreadRequestResult> {
  const action = request.action;
  if (options.endpointDelivery && (action === "send" || action === "reconcile_delivery")) {
    return executeEndpointAgentDelivery(request, options.endpointDelivery);
  }
  if (request.agentAdapter === "grokBot") {
    if (!options.invokeAgentOperation) throw new Error("The Grok Bot plugin is unavailable.");
    return options.invokeAgentOperation<AgentThreadRequestResult>("grokBot", "threads.request", { request }, {
      assertCurrent: options.requestAuthority
    });
  }
  if (action === "list") {
    const agentAdapter = threadAgentAdapter(request);
    const query = optionalText(request.query, "query", maxQueryLength);
    const requestedLimit = Number(request.limit ?? defaultListLimit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(maxListLimit, Math.floor(requestedLimit)))
      : defaultListLimit;
    const requestedOffset = Number(request.offset ?? 0);
    const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;
    const page = await listThreadsForAdapter(
      agentAdapter,
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
      data: { action, agentAdapter, query, offset, threads, nextOffset: hasMore ? offset + threads.length : null }
    };
  }

  if (action === "reconcile_delivery") {
    if (!options.agentRequests) throw new Error("Agent request tracking is unavailable.");
    const reconcileAdapter = threadAgentAdapter(request);
    if (!agentAdapterSupportsReceiptRecovery(reconcileAdapter)) {
      throw new Error(
        `adapter_has_no_receipt_log: agentAdapter=${reconcileAdapter} keeps no readable inbound log, so a lost delivery receipt cannot be reconstructed.`
      );
    }
    const threadId = normalizeThreadId(request.threadId);
    const deliveryId = optionalText(request.deliveryId, "deliveryId", 200);
    if (!deliveryId) throw new Error("deliveryId is required for receipt reconciliation.");
    const communication = await recoverAgentResponseDeliveryFromRollout(options.agentRequests, threadId, deliveryId);
    const confirmed = communication.status === "receipt_recovered" || communication.status === "already_recorded";
    return { statusCode: confirmed ? 200 : 202, data: {
      action, threadId, ok: confirmed, status: communication.status, communication,
      ...(!confirmed ? { error: {
        code: "delivery_reconciliation_pending", reason: communication.status, retryable: false,
        commitState: "not_started",
        nextAction: "Verify the original reservation and exact receiving task. Keep the original deliveryId; do not resend the message to repair its receipt."
      } } : {})
    } };
  }

  if (action === "read") {
    const agentAdapter = threadAgentAdapter(request);
    const threadId = normalizeThreadId(request.threadId);
    const thread = await readAgentThreadForAdapter(agentAdapter, threadId, options, driver);
    const deliveryId = optionalText(request.deliveryId, "deliveryId", 200) || undefined;
    const rolloutReceiptConfirmed = Boolean(
      deliveryId
      && agentAdapterSupportsReceiptRecovery(agentAdapter)
      && driver === defaultDriver
      && await codexDesktopDeliveryReceiptConfirmed(threadId, deliveryId)
    );
    const delivery = deliveryId
      ? {
          deliveryId,
          state: agentThreadDeliveryStateForTest(thread.value, deliveryId, rolloutReceiptConfirmed)
        }
      : undefined;
    return {
      statusCode: 200,
      data: { action, agentAdapter, threadId, thread: thread.value, ...(delivery ? { delivery } : {}) }
    };
  }

  if (action === "open") {
    const agentAdapter = threadAgentAdapter(request);
    const threadId = normalizeThreadId(request.threadId);
    const cwd = resolveAgentThreadWorkspaceForTest(request.cwd, options);
    const exact = await readAgentThreadForAdapter(agentAdapter, threadId, options, driver);
    const thread = exact.summary;
    if (!thread || thread.id !== threadId) {
      throw new Error(`Agent ${agentAdapter === "dsh" ? "session" : "task"} could not be read by exact ID: ${threadId}`);
    }
    if (thread.archived) {
      throw new Error(`Agent ${agentAdapter === "dsh" ? "session" : "task"} is archived: ${threadId}`);
    }
    // A session's directory is identity detail, not an admission gate: an enabled
    // Agent may drive any loaded session unless a limit is configured explicitly.
    if (agentAdapter === "workbuddy") {
      throw new Error("Opening a WorkBuddy task happens inside the WorkBuddy app; the bridge cannot open one.");
    }
    if (agentAdapter === "dsh") {
      await (options.openDshSession ?? openDshSession)(threadId, await dshBaseUrlFor(options));
    } else {
      await (options.openCodexThread ?? openCodexDesktopThread)(threadId);
    }
    return {
      statusCode: 200,
      data: {
        action,
        agentAdapter,
        threadId,
        thread,
        status: "opened",
        owner: agentAdapter === "dsh" ? "dsh_web" : "codex_desktop"
      }
    };
  }

  if (action === "resolve") {
    const agentAdapter = threadAgentAdapter(request);
    const rawThreadId = optionalText(request.threadId, "threadId", maxThreadIdLength);
    const fallbackTitle = agentAdapter === "dsh"
      ? rawThreadId
      : (!isCodexTaskId(rawThreadId) ? rawThreadId : "");
    const title = requiredText(request.title || fallbackTitle, "title", maxTitleInputLength);
    const requestedWorkspace = resolveAgentThreadWorkspaceForTest(request.cwd, options);
    if (agentAdapter === "dsh" && driver === defaultDriver) {
      const resolution = await resolveDshSession({
        sessionId: rawThreadId,
        title,
        cwd: requestedWorkspace,
        createIfMissing: request.createIfMissing !== false,
        baseUrl: await dshBaseUrlFor(options),
        agentPreset: options.dshAgentPreset
      });
      if (resolution.kind === "ambiguous") {
        return {
          statusCode: 409,
          data: {
            action,
            agentAdapter,
            resolution: resolution.kind,
            message: `存在 ${resolution.candidates.length} 个同名 DSH 会话，最后更新时间并列，请选择具体会话。`,
            candidates: resolution.candidates
          }
        };
      }
      if (resolution.kind === "missing") {
        return {
          statusCode: 404,
          data: { action, agentAdapter, resolution: resolution.kind, message: `没有找到 DSH 会话：${title}`, nextAction: missingThreadNextAction(agentAdapter) }
        };
      }
      return {
        statusCode: resolution.kind === "created" ? 201 : 200,
        data: { action, agentAdapter, resolution: resolution.kind, thread: resolution.thread }
      };
    }
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
        create: (context) => createThreadDurably(
          request,
          options,
          driver,
          title,
          requestedWorkspace,
          context?.reason === "archived" ? context.previousThread?.id : undefined
        )
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
        data: { action, resolution: "missing", message: `没有找到 Codex Desktop 任务：${title}`, nextAction: missingThreadNextAction("codex") }
      };
    }
    return {
      statusCode: resolution.kind === "created" ? 201 : 200,
      data: { action, resolution: resolution.kind, thread: resolution.thread }
    };
  }

  if (action === "create") {
    const agentAdapter = threadAgentAdapter(request);
    if (agentAdapter === "workbuddy") {
      throw new Error("WorkBuddy tasks are created inside the WorkBuddy app; the bridge cannot create one.");
    }
    const sandbox = normalizeSandbox(request.sandbox);
    const initialPrompt = optionalText(request.prompt, "prompt", maxPromptLength);
    if (options.creationIntent && initialPrompt) throw new Error("Caller-bound metadata creation cannot execute an initial prompt.");
    const declaredMessageSource = initialPrompt
      ? describeAgentThreadMessageSource(request.messageSource, options.remoteSource)
      : undefined;
    const sendAttribution = declaredMessageSource
      ? agentThreadSendAttribution(request, options, declaredMessageSource)
      : null;
    const messageSource = sendAttribution?.messageSource ?? declaredMessageSource;
    const deliveryRequest = messageSource ? { ...request, messageSource } : request;
    const rawTitle = requiredText(request.title, "title", maxTitleInputLength);
    const title = agentAdapter === "dsh" ? rawTitle : normalizeCodexThreadTitle(rawTitle);
    const cwd = resolveAgentThreadWorkspaceForTest(request.cwd, options);
    if (agentAdapter === "dsh" && driver === defaultDriver) {
      const resolution = await resolveDshSession({
        title,
        cwd,
        createIfMissing: true,
        baseUrl: await dshBaseUrlFor(options),
        agentPreset: options.dshAgentPreset
      });
      if (resolution.kind === "ambiguous") {
        return {
          statusCode: 409,
          data: {
            action,
            agentAdapter,
            resolution: resolution.kind,
            message: `存在 ${resolution.candidates.length} 个同名 DSH 会话，最后更新时间并列，请选择具体会话。`,
            candidates: resolution.candidates,
            sandbox,
            ...(messageSource ? { messageSource } : {})
          }
        };
      }
      if (resolution.kind === "missing") {
        return {
          statusCode: 404,
          data: {
            action,
            agentAdapter,
            resolution: resolution.kind,
            message: `没有找到或创建 DSH 会话：${title}`, nextAction: missingThreadNextAction(agentAdapter),
            sandbox,
            ...(messageSource ? { messageSource } : {})
          }
        };
      }
      let initialTurnStatus: "not-requested" | "started" = "not-requested";
      if (initialPrompt) {
        try {
          await sendDshSessionMessage({
            sessionId: resolution.thread.id,
            prompt: standaloneWorkspacePolicyPrompt(
              initialPrompt,
              messageSource!,
              cwd,
              deliveryBlocks(request.contextBlocks, "contextBlocks"),
              deliveryBlocks(request.controlBlocks, "controlBlocks")
            ),
            cwd,
            baseUrl: await dshBaseUrlFor(options),
            imagePaths: imagePathsForDelivery(request.imagePaths)
          });
          initialTurnStatus = "started";
        } catch (error) {
          throw new AgentThreadDeliveryError(error instanceof Error ? error.message : String(error));
        }
      }
      return {
        statusCode: resolution.kind === "created" ? 201 : 200,
        data: {
          action,
          agentAdapter,
          resolution: resolution.kind,
          thread: resolution.thread,
          sandbox,
          initialTurnStatus,
          ...(messageSource ? { messageSource } : {})
        }
      };
    }
    let resolution: CodexSessionResolution<AgentThreadSummary>;
    try {
      resolution = options.creationIntent ? { kind: "created", thread: await createThreadDurably(deliveryRequest, options, driver, title, cwd) } : await resolveCodexSession({
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
        create: () => createThreadDurably(deliveryRequest, options, driver, title, cwd)
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
          sandbox,
          ...(messageSource ? { messageSource } : {})
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
          sandbox,
          ...(messageSource ? { messageSource } : {})
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
          sandbox,
          ...(messageSource ? { messageSource } : {})
        }
      };
    }
    if (resolution.kind === "missing") {
      return {
        statusCode: 404,
        data: {
          action,
          resolution: "missing",
          message: `没有找到或创建 Codex Desktop 任务：${title}`, nextAction: missingThreadNextAction("codex"),
          sandbox,
          ...(messageSource ? { messageSource } : {})
        }
      };
    }
    return {
      statusCode: resolution.kind === "created" ? 201 : 200,
      data: {
        action,
        resolution: resolution.kind,
        thread: resolution.thread,
        sandbox,
        ...(messageSource ? { messageSource } : {})
      }
    };
  }

  if (action === "rename") {
    const agentAdapter = threadAgentAdapter(request);
    if (agentAdapter === "workbuddy") {
      throw new Error("WorkBuddy task titles are owned by the WorkBuddy app; the bridge cannot rename one.");
    }
    const threadId = normalizeThreadId(request.threadId);
    const rawTitle = requiredText(request.title, "title", maxTitleInputLength);
    const title = agentAdapter === "dsh" ? rawTitle : normalizeCodexThreadTitle(rawTitle);
    const cwd = resolveAgentThreadWorkspaceForTest(request.cwd, options);
    const thread = agentAdapter === "dsh" && driver === defaultDriver
      ? await renameDshSession({
          sessionId: threadId,
          title,
          cwd,
          baseUrl: await dshBaseUrlFor(options)
        })
      : driver.rename
        ? await driver.rename({ threadId, title, cwd })
        : (() => { throw new Error("Agent thread rename is not supported by this driver."); })();
    return { statusCode: 200, data: { action, agentAdapter, thread } };
  }

  if (action === "send") {
    await options.agentRequests?.ready();
    let targetAgentAdapter = threadAgentAdapter(request);
    let threadId = normalizeThreadId(request.threadId);
    const rawPrompt = request.inReplyToRequestId && options.agentRequests
      ? optionalText(request.prompt, "prompt", maxPromptLength) || ""
      : requiredText(request.prompt, "prompt", maxPromptLength);
    const messageSource = describeAgentThreadMessageSource(request.messageSource, options.remoteSource);
    const sendSource = messageSource ? agentThreadSendAttribution(request, options, messageSource) : null;
    let cwd = resolveAgentThreadWorkspaceForTest(request.cwd, options);
    const inReplyToRequestId = optionalText(request.inReplyToRequestId, "inReplyToRequestId", 100) || undefined;
    let requestedTitle = optionalText(request.title, "title", maxTitleInputLength);
    let redirectedReply = false;
    if (sendSource && inReplyToRequestId && options.agentRequests) {
      const pending = options.agentRequests.get(inReplyToRequestId);
      if (pending?.status === "pending_delivery") {
        // The original request supplies the reply route; only its real receipt can confirm acceptance.
        const reason = !agentAdapterSupportsReceiptRecovery(pending.target.agentAdapter) ? "delivery_receipt_adapter_not_supported"
          : pending.source.threadId !== threadId ? "reply_destination_does_not_match_original_source"
          : undefined;
        if (reason) throw new AgentReplyStateError(pending, reason);
        let confirmed: boolean;
        try {
          confirmed = await (options.confirmCodexDelivery ?? codexDesktopDeliveryReceiptConfirmed)(pending.target.threadId, pending.deliveryId);
        } catch {
          throw new AgentReplyStateError(pending, "original_delivery_receipt_unreadable");
        }
        if (!confirmed) throw new AgentReplyStateError(pending, "original_delivery_receipt_not_found");
        await options.agentRequests.commit({
          ...pending,
          requestId: pending.id,
          responsePolicy: "required"
        }, { action: "receipt_recovered", transport: "desktop-ipc" });
      }
      const destination = options.agentRequests.resolveReplyDestination(
        inReplyToRequestId,
        {
          threadId: sendSource.source.threadId,
          agentType: sendSource.source.agentType,
          threadName: sendSource.source.threadName,
          workspace: sendSource.source.workspace
        },
        { threadId, agentType: "agent", workspace: cwd }
      );
      if (destination) {
        threadId = normalizeThreadId(destination.threadId);
        targetAgentAdapter = threadAgentAdapter({ threadId });
        cwd = resolveAgentThreadWorkspaceForTest(destination.workspace, options);
        requestedTitle = requestedTitle || destination.threadName || "";
        redirectedReply = true;
      }
    }
    const previousThreadId = threadId;
    const previousThreadWorkspace = cwd;
    let targetResolution: { kind: "id" | "name" | "created"; thread: AgentThreadSummary } | undefined;
    if (requestedTitle && !redirectedReply && targetAgentAdapter === "dsh" && driver === defaultDriver) {
      const title = requestedTitle.trim();
      const resolution = await resolveDshSession({
        sessionId: threadId,
        title,
        cwd,
        createIfMissing: request.createIfMissing !== false,
        baseUrl: await dshBaseUrlFor(options),
        agentPreset: options.dshAgentPreset
      });
      if (resolution.kind === "ambiguous") {
        throw new Error(`DSH session name is ambiguous: ${title}`);
      }
      if (resolution.kind === "missing") {
        throw new Error(`DSH session could not be resolved: ${title}`);
      }
      // A session's directory is identity detail, not an admission gate: an enabled
      // Agent may drive any loaded session unless a limit is configured explicitly.
      targetResolution = resolution.kind === "workspace-mismatch"
        ? { kind: "id", thread: resolution.thread }
        : resolution;
      threadId = resolution.thread.id;
      cwd = resolveAgentThreadWorkspaceForTest(resolution.thread.cwd || cwd, options);
    } else if (requestedTitle && !isDshSessionId(threadId)) {
      const title = normalizeCodexThreadTitle(requestedTitle);
      const resolution = await resolveCodexSession({
        threadId,
        title,
        cwd,
        createIfMissing: request.createIfMissing !== false
      }, {
        scope: driver,
        read: async (candidateId) => {
          try {
            return threadSummary(await driver.read(candidateId));
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
        create: (context) => createThreadDurably(
          { ...request, prompt: "" },
          options,
          driver,
          title,
          cwd,
          context?.reason === "archived" ? context.previousThread?.id : undefined
        )
      });
      if (resolution.kind === "ambiguous") {
        throw new Error(`Codex Desktop task name is ambiguous: ${title}`);
      }
      if (resolution.kind === "archived") {
        throw new Error(`Codex Desktop task is archived: ${title}`);
      }
      if (resolution.kind === "missing") {
        throw new Error(`Codex Desktop task could not be resolved: ${title}`);
      }
      targetResolution = resolution;
      threadId = resolution.thread.id;
      if (resolution.kind !== "id") {
        cwd = resolveAgentThreadWorkspaceForTest(resolution.thread.cwd || cwd, options);
      }
    }
    if (targetResolution?.kind === "created") {
      await reconcileOpenAgentRequestPartiesForReplacement(
        options.agentRequests,
        previousThreadId,
        previousThreadWorkspace,
        targetResolution.thread
      );
    }
    if (targetAgentAdapter === "dsh" && driver === defaultDriver && !targetResolution) {
      const resolution = await resolveDshSession({
        sessionId: threadId,
        title: threadId,
        cwd,
        createIfMissing: false,
        baseUrl: await dshBaseUrlFor(options),
        agentPreset: options.dshAgentPreset
      });
      if (resolution.kind === "missing") {
        throw new Error(`DSH session could not be resolved: ${threadId}`);
      }
      if (resolution.kind === "ambiguous") {
        throw new Error(`DSH session name is ambiguous: ${threadId}`);
      }
      targetResolution = resolution.kind === "workspace-mismatch"
        ? { kind: "id", thread: resolution.thread }
        : resolution;
      threadId = resolution.thread.id;
    }
    const sandbox = normalizeSandbox(request.sandbox);
    const requestedModel = optionalText(request.model, "model", 120) || undefined;
    const defaults = targetAgentAdapter === "codex" ? options.codexDefaults : undefined;
    const model = requestedModel || optionalText(defaults?.model, "codexDefaults.model", 120) || undefined;
    const reasoningEffort = normalizeReasoningEffort(request.reasoningEffort)
      ?? (requestedModel ? undefined : normalizeReasoningEffort(defaults?.reasoningEffort));
    const imagePaths = imagePathsForDelivery(request.imagePaths);
    const messageProcessing = request.messageProcessing;
    const responsePolicy = sendSource ? normalizeAgentResponsePolicy(request.responsePolicy ?? "none") : undefined;
    if (messageProcessing && responsePolicy !== "required") {
      throw new Error("messageProcessing handoff requires responsePolicy=required.");
    }
    const responseInstruction = sendSource
      ? optionalText(request.responseInstruction, "responseInstruction", 4_000) || undefined
      : undefined;
    const result = sendSource
      ? optionalText(request.result, "result", 12_000) || undefined
      : undefined;
    const nextAction = sendSource
      ? optionalText(request.nextAction, "nextAction", 4_000) || undefined
      : undefined;
    if (sendSource && (responsePolicy === "required" || inReplyToRequestId) && !options.agentRequests) {
      throw new Error("Agent request tracking is unavailable for this Agent-to-Agent delivery.");
    }

    const prepareAgentCommunication = async (): Promise<AgentCommunicationPreparation | undefined> => {
      if (!sendSource || !responsePolicy) return undefined;
      return options.agentRequests
        ? await options.agentRequests.prepare({
            source: {
              agentAdapter: sendSource.source.agentAdapter,
              threadId: sendSource.source.threadId,
              agentType: sendSource.source.agentType,
              threadName: sendSource.source.threadName,
              workspace: sendSource.source.workspace,
              ...(sendSource.source.endpoint ? { endpoint: sendSource.source.endpoint } : {})
            },
            target: {
              agentAdapter: targetAgentAdapter,
              threadId,
              agentType: "agent",
              threadName: targetResolution?.thread.title || requestedTitle || threadId,
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
            deliveryId: randomUUID(),
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
            target: {
              agentAdapter: targetAgentAdapter,
              threadId,
              agentType: "agent",
              threadName: targetResolution?.thread.title || requestedTitle || threadId,
              workspace: cwd
            }
          };
    };

    const standaloneDeliveryId = sendSource ? undefined : optionalText(request.deliveryId, "deliveryId", 200) || randomUUID();
    const renderPrompt = (agentCommunication: AgentCommunicationPreparation | undefined): string => sendSource
      ? renderRabiDelivery({
          messageSource: sendSource.messageSource,
          messageContent: agentCommunication?.inReplyToRequestId
            ? renderAgentResponseContent(rawPrompt, agentCommunication.result!, agentCommunication.nextAction!)
            : rawPrompt,
          escapeMessageContentHeaders: !agentCommunication?.inReplyToRequestId,
          contextBlocks: deliveryBlocks(request.contextBlocks, "contextBlocks"),
          controlBlocks: [
            ...deliveryBlocks(request.controlBlocks, "controlBlocks"),
            ...(agentCommunication ? [renderAgentReplyParameters(agentCommunication)] : [])
          ]
        })
      : standaloneWorkspacePolicyPrompt(
          rawPrompt,
          messageSource,
          cwd,
          deliveryBlocks(request.contextBlocks, "contextBlocks"),
          deliveryBlocks(request.controlBlocks, "controlBlocks"),
          standaloneDeliveryId
        );

    let messageProcessingEvent: {
      requirementId: string;
      sourceThreadId: string;
      targetThreadId: string;
      targetAgentType: AgentThreadSourceType;
      planId?: string;
      planTitle?: string;
    } | undefined;
    if (messageProcessing != null) {
      const requirementId = requiredText(messageProcessing.requirementId, "messageProcessing.requirementId", 300);
      if (messageProcessing.outcome !== "handoff") {
        throw new Error("messageProcessing.outcome must be handoff for Agent thread delivery.");
      }
      messageProcessingEvent = {
        requirementId,
        sourceThreadId: sendSource?.source.threadId ?? request.sourceThreadId ?? "",
        targetThreadId: threadId,
        targetAgentType: normalizeAgentThreadSourceType(requiredText(messageProcessing.targetAgentType, "messageProcessing.targetAgentType", 40)),
        planId: optionalText(messageProcessing.planId, "messageProcessing.planId", 300) || undefined,
        planTitle: optionalText(messageProcessing.planTitle, "messageProcessing.planTitle", 500) || undefined
      };
    }

    const sendToTarget = async (prompt: string): Promise<Awaited<ReturnType<AgentThreadDriver["send"]>>> => {
      const delivery = { threadId, prompt, cwd, sandbox } as Parameters<AgentThreadDriver["send"]>[0];
      if (model) delivery.model = model;
      if (reasoningEffort) delivery.reasoningEffort = reasoningEffort;
      if (imagePaths.length) delivery.imagePaths = imagePaths;
      if (targetAgentAdapter === "workbuddy" && driver === defaultDriver) {
        if (imagePaths.length) {
          throw new Error("WorkBuddy deliveries do not carry image attachments.");
        }
        return await sendWorkbuddyThreadMessage({ threadId, prompt, cwd });
      }
      return targetAgentAdapter === "dsh" && driver === defaultDriver
        ? await sendDshSessionMessage({
            sessionId: threadId,
            prompt,
            cwd,
            baseUrl: await dshBaseUrlFor(options),
            mode: request.dshDeliveryMode,
            imagePaths: delivery.imagePaths
          })
        : driver.send(delivery);
    };

    let agentCommunication = await prepareAgentCommunication();
    let prompt = renderPrompt(agentCommunication);
    const unconfirmedResult = (error: unknown): AgentThreadRequestResult | undefined => {
      if (!(error instanceof Error) || error.name !== "CodexDesktopDeliveryUnconfirmedError") return undefined;
      return {
        statusCode: 202,
        data: {
          action, ok: false, status: "delivery_unconfirmed", threadId,
          delivery: {
            status: "unconfirmed", targetThreadId: threadId,
            deliveryId: agentCommunication?.deliveryId ?? standaloneDeliveryId
          },
          ...(agentCommunication ? { communication: {
            deliveryId: agentCommunication.deliveryId,
            responsePolicy: agentCommunication.responsePolicy,
            requestId: agentCommunication.requestId,
            requestStatus: agentCommunication.requestId ? "pending_delivery" : undefined,
            inReplyToRequestId: agentCommunication.inReplyToRequestId
          } } : {}),
          error: { stage: "target_delivery", message: error.message, retryable: false }
        }
      };
    };
    let acceptedDelivery: Awaited<ReturnType<AgentThreadDriver["send"]>>;
    let replacementWarning: string | undefined;
    try {
      if (agentCommunication) await options.agentRequests?.bindResponseEvidence(agentCommunication, prompt);
      acceptedDelivery = await sendToTarget(prompt);
    } catch (error) {
      const unconfirmed = unconfirmedResult(error);
      if (unconfirmed) return unconfirmed;
      if (["AGENT_REQUEST_STORE_UNAVAILABLE", "AGENT_REQUEST_COMMIT_UNKNOWN"].includes(String((error as { code?: unknown })?.code))) throw error;
      const staleThreadId = threadId;
      const staleWorkspace = cwd;
      const replacement = targetAgentAdapter === "codex" && requestedTitle
        ? await createReplacementForMissingCodexDeliveryTarget(
            request,
            options,
            driver,
            { threadId: staleThreadId, title: normalizeCodexThreadTitle(requestedTitle), cwd: staleWorkspace },
            error
          )
        : null;
      if (!replacement) {
        if (agentCommunication && options.agentRequests) await options.agentRequests.abort(agentCommunication);
        throw new AgentThreadDeliveryError(error instanceof Error ? error.message : String(error));
      }

      if (agentCommunication && options.agentRequests) await options.agentRequests.abort(agentCommunication);
      await reconcileOpenAgentRequestPartiesForReplacement(
        options.agentRequests,
        staleThreadId,
        staleWorkspace,
        replacement
      );
      targetResolution = { kind: "created", thread: replacement };
      threadId = replacement.id;
      cwd = resolveAgentThreadWorkspaceForTest(replacement.cwd || cwd, options);
      if (messageProcessingEvent) messageProcessingEvent.targetThreadId = threadId;
      agentCommunication = await prepareAgentCommunication();
      prompt = renderPrompt(agentCommunication);
      try {
        if (agentCommunication) await options.agentRequests?.bindResponseEvidence(agentCommunication, prompt);
      acceptedDelivery = await sendToTarget(prompt);
      } catch (replacementError) {
        const unconfirmed = unconfirmedResult(replacementError);
        if (unconfirmed) return unconfirmed;
        if (["AGENT_REQUEST_STORE_UNAVAILABLE", "AGENT_REQUEST_COMMIT_UNKNOWN"].includes(String((replacementError as { code?: unknown })?.code))) throw replacementError;
        if (agentCommunication && options.agentRequests) await options.agentRequests.abort(agentCommunication);
        throw new AgentThreadDeliveryError(replacementError instanceof Error ? replacementError.message : String(replacementError));
      }
      replacementWarning = `原 Codex Desktop 任务 ${previousThreadId} 已不存在；已创建替代任务 ${threadId} 并投递本次消息。`;
    }
    const acceptedReceipt = acceptedDelivery && typeof acceptedDelivery === "object"
      ? acceptedDelivery
      : undefined;
    const receiptAttribution = deliveryReceiptAttribution(targetAgentAdapter);
    let messageProcessingWarning: string | undefined;
    let agentRequestWarning: string | undefined;
    let committedAgentRequest: Awaited<ReturnType<AgentRequestStore["commit"]>> | undefined;
    if (agentCommunication && options.agentRequests) {
      try {
        committedAgentRequest = await options.agentRequests.commit(agentCommunication, {
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
        agentAdapter: targetAgentAdapter,
        ok: !messageProcessingWarning && !agentRequestWarning,
        threadId,
        ...(targetResolution ? {
          resolution: targetResolution.kind,
          thread: targetResolution.thread,
          ...(previousThreadId !== threadId ? { previousThreadId } : {})
        } : {}),
        status: messageProcessingWarning || agentRequestWarning ? "delivered_tracking_failed" : "delivered",
        delivery: {
          status: "delivered",
          targetThreadId: threadId,
          deliveryId: agentCommunication?.deliveryId ?? standaloneDeliveryId,
          acceptedBy: receiptAttribution.acceptedBy,
          action: acceptedReceipt?.action ?? "accepted",
          transport: acceptedReceipt?.transport ?? receiptAttribution.transport,
          ...(acceptedReceipt ? { openedThread: acceptedReceipt.openedThread } : {}),
          ...(acceptedReceipt?.warning ? { warning: acceptedReceipt.warning } : {})
        },
        sandbox,
        model,
        reasoningEffort,
        messageSource: sendSource?.messageSource ?? messageSource,
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
        ...((replacementWarning || messageProcessingWarning || agentRequestWarning) ? {
          warning: [replacementWarning, messageProcessingWarning, agentRequestWarning].filter(Boolean).join(" ")
        } : {})
      }
    };
  }

  throw new Error("Unsupported Agent thread action. Expected list, read, reconcile_delivery, open, resolve, create, rename, or send.");
}
