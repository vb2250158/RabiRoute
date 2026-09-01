import { isCodexTaskId } from "./codexTaskId.js";
import { proactiveCommunicationPolicyLines } from "./agentCommunicationPolicy.js";
import { codexThreadTitleMaxLength, normalizeCodexThreadTitle } from "./codexThreadTitle.js";
import { roleStorageMutationContractLines } from "./roleStorageMutationContract.js";

export const MAX_CODEX_PLAN_ASSISTANT_SESSIONS = 8;
export const DEFAULT_CODEX_PLAN_ASSISTANT_MODEL = "gpt-5.6-terra";

export type CodexPlanAssistantSession = {
  /** Omitted on legacy Codex rows; DSH rows persist their owner explicitly. */
  agentAdapter?: "codex" | "dsh";
  threadId: string;
  threadName: string;
  workspace: string;
  index: number;
  /** Legacy input and runtime projection only. Manager configuration owns the shared secretary model. */
  model?: string;
  initializedAt?: string;
};

export function planAssistantSessionAgentAdapter(session: Pick<CodexPlanAssistantSession, "agentAdapter" | "threadId">): "codex" | "dsh" {
  return session.agentAdapter === "dsh" || session.threadId.startsWith("session-") ? "dsh" : "codex";
}

export function normalizeCodexPlanAssistantModel(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_CODEX_PLAN_ASSISTANT_MODEL;
}

export function resolveCodexPlanAssistantTurnModel(
  sessions: readonly CodexPlanAssistantSession[] | undefined,
  threadIdValue: unknown,
  requestedModel: unknown
): string | undefined {
  const explicitModel = typeof requestedModel === "string" ? requestedModel.trim() : "";
  if (explicitModel) return explicitModel;
  const threadId = typeof threadIdValue === "string" ? threadIdValue.trim() : "";
  if (!threadId) return undefined;
  const session = sessions?.find((item) => item.threadId === threadId);
  return session ? normalizeCodexPlanAssistantModel(session.model) : undefined;
}

function trimDanglingHighSurrogate(value: string): string {
  if (!value) return value;
  const lastCodeUnit = value.charCodeAt(value.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? value.slice(0, -1) : value;
}

export function normalizeCodexPlanAssistantCount(value: unknown): number {
  const count = Math.floor(Number(value) || 1);
  return Math.max(1, Math.min(MAX_CODEX_PLAN_ASSISTANT_SESSIONS, count));
}

export function codexPlanAssistantSessionTitle(baseTitle: unknown, countValue: unknown, indexValue: unknown): string {
  const count = normalizeCodexPlanAssistantCount(countValue);
  const index = Math.max(1, Math.min(count, Math.floor(Number(indexValue) || 1)));
  const suffix = count === 1 ? " 协助处理计划" : ` 协助处理计划${index}`;
  const fallback = "RabiRoute";
  const rawBase = String(baseTitle || fallback).trim() || fallback;
  const maximumBaseLength = Math.max(1, codexThreadTitleMaxLength - suffix.length);
  const base = trimDanglingHighSurrogate(rawBase.slice(0, maximumBaseLength)).trimEnd() || fallback;
  return normalizeCodexThreadTitle(`${base}${suffix}`);
}

export function codexPlanAssistantSessionTitles(baseTitle: unknown, countValue: unknown): string[] {
  const count = normalizeCodexPlanAssistantCount(countValue);
  return Array.from({ length: count }, (_, index) => codexPlanAssistantSessionTitle(baseTitle, count, index + 1));
}

export function normalizeCodexPlanAssistantSessions(value: unknown): CodexPlanAssistantSession[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item, offset) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as Partial<CodexPlanAssistantSession>;
    const threadId = String(raw.threadId || "").trim();
    const threadName = String(raw.threadName || "").trim();
    const workspace = String(raw.workspace || "").trim();
    const inferredAgentAdapter = isCodexTaskId(threadId)
      ? "codex"
      : /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)
        ? "dsh"
        : undefined;
    const explicitAgentAdapter = raw.agentAdapter === "codex" || raw.agentAdapter === "dsh"
      ? raw.agentAdapter
      : undefined;
    if (!inferredAgentAdapter || (explicitAgentAdapter && explicitAgentAdapter !== inferredAgentAdapter)
      || !threadName || !workspace || seen.has(threadId)) return [];
    seen.add(threadId);
    return [{
      ...(inferredAgentAdapter === "dsh" ? { agentAdapter: "dsh" as const } : {}),
      threadId,
      threadName: normalizeCodexThreadTitle(threadName),
      workspace,
      index: Math.max(1, Math.floor(Number(raw.index) || offset + 1)),
      model: normalizeCodexPlanAssistantModel(raw.model),
      initializedAt: typeof raw.initializedAt === "string" && raw.initializedAt.trim()
        ? raw.initializedAt.trim()
        : undefined
    }];
  }).sort((left, right) => left.index - right.index)
    .slice(0, MAX_CODEX_PLAN_ASSISTANT_SESSIONS)
    .map((item, index) => ({ ...item, index: index + 1 }));
}

export function codexPlanAssistantInitializationPrompt(input: {
  roleId: string;
  sourceAgentAdapter: "codex" | "dsh";
  assistantAgentAdapter: "codex" | "dsh";
  sourceThreadId: string;
  sourceThreadName: string;
  assistantThreadId: string;
  assistantThreadName: string;
  workspace: string;
  count: number;
  index: number;
  managerBaseUrl: string;
}): string {
  const count = normalizeCodexPlanAssistantCount(input.count);
  const index = Math.max(1, Math.min(count, Math.floor(input.index) || 1));
  const managerBaseUrl = String(input.managerBaseUrl || "").trim().replace(/\/+$/, "");
  if (!managerBaseUrl) throw new Error("managerBaseUrl is required for a plan assistant session.");
  return [
    `[rabi:bind ${input.roleId}]`,
    "[计划协助会话初始化]",
    `主会话：${input.sourceThreadName}`,
    `主会话 ID：${input.sourceThreadId}`,
    `本秘书任务：${input.assistantThreadName}`,
    `本秘书会话 ID：${input.assistantThreadId}`,
    `工作目录：${input.workspace}`,
    `协助槽位：${index}/${count}`,
    `Rabi Manager：${managerBaseUrl}`,
    "",
    "你是持久计划秘书，只管理控制面：读取计划、记忆和业务任务状态，维护步骤与恢复点，消费结果，查重、创建或续投独立业务任务。",
    ...proactiveCommunicationPolicyLines("internal"),
    "存在可执行的询问、补证据、重试、改道、拆分、升级或续投时，本轮执行一项并更新计划与记忆。",
    "taskBinding 只指向独立业务任务；secretaryBinding 记录秘书。秘书不执行调查、代码、资源、构建、发布或外部操作。",
    "同一 planId 只有一个控制面 writer；不同计划可并行。共享记录只合并目标项。",
    "消费业务结果、更新计划与记忆并续投。仅把决定、批准、授权、缺少输入或最终复核升级给主人格；写明计划更新、taskBinding 状态、续投、下一动作、风险和待决定问题。",
    `Agent 投递使用 Manager 线程桥，填写 agentAdapter=${input.sourceAgentAdapter}、messageSource={"type":"agent","agentAdapter":"${input.assistantAgentAdapter}","sessionId":"${input.assistantThreadId}","sessionName":"${input.assistantThreadName}"}、sourceThreadId=${input.assistantThreadId}、sourceAgentType=plan_secretary 和 responsePolicy；要求回复时补 responseInstruction。`,
    `需要主人格处理时投递到 threadId=${input.sourceThreadId} 并取得回执。`,
    "如果本轮没有需要主人格或用户处理的内容，最终输出明确写“处理结果：仅更新控制面，无需外部通知”，不要生成像是已经对用户说过的话。",
    `计划接口：${managerBaseUrl}/api/roles/${encodeURIComponent(input.roleId)}/plans`,
    ...roleStorageMutationContractLines(`${managerBaseUrl}/api/roles/${encodeURIComponent(input.roleId)}`),
    `线程桥：${managerBaseUrl}/api/agent/threads`,
    "收到任务后读取计划、记忆、taskBinding 和必读资料；单轮结束不等于计划完成。"
  ].join("\n");
}
