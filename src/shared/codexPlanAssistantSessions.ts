import { isCodexTaskId } from "./codexTaskId.js";
import { codexThreadTitleMaxLength, normalizeCodexThreadTitle } from "./codexThreadTitle.js";

export const MAX_CODEX_PLAN_ASSISTANT_SESSIONS = 8;

export type CodexPlanAssistantSession = {
  threadId: string;
  threadName: string;
  workspace: string;
  index: number;
  initializedAt?: string;
};

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
    if (!isCodexTaskId(threadId) || !threadName || !workspace || seen.has(threadId)) return [];
    seen.add(threadId);
    return [{
      threadId,
      threadName: normalizeCodexThreadTitle(threadName),
      workspace,
      index: Math.max(1, Math.floor(Number(raw.index) || offset + 1)),
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
  sourceThreadId: string;
  sourceThreadName: string;
  workspace: string;
  count: number;
  index: number;
  managerBaseUrl?: string;
}): string {
  const count = normalizeCodexPlanAssistantCount(input.count);
  const index = Math.max(1, Math.min(count, Math.floor(input.index) || 1));
  const managerBaseUrl = String(input.managerBaseUrl || "http://127.0.0.1:8790").replace(/\/+$/, "");
  return [
    `[rabi:bind ${input.roleId}]`,
    "[计划协助会话初始化]",
    `主会话：${input.sourceThreadName}`,
    `主会话 ID：${input.sourceThreadId}`,
    `工作目录：${input.workspace}`,
    `协助槽位：${index}/${count}`,
    `Rabi Manager：${managerBaseUrl}`,
    "",
    "你是主会话的持久计划协助任务，不是一次性子 Agent，也不替代主会话 owner。",
    "你的职责是接收主会话分配的一条计划，读取该计划的真实 JSON、执行或跟进当前步骤，并在每轮结束前更新计划状态。",
    "同一时间只承接一条未完成计划；新计划只有在上一条已完成、已暂停或已解除 taskBinding 后才能绑定到本会话。",
    "为提高效率，你可以为边界清楚、互不冲突的调查或执行步骤创建临时子 Agent；但你仍是该计划的长期 owner，必须汇总子 Agent 结果、更新计划并向主会话回传，不能把负责人身份交给子 Agent。",
    "主会话分配任务时，计划 taskBinding 必须保存本会话完整 ID、名称和 workspace；Stop Hook 会把你的最终阶段结果送回主会话。",
    "阶段回传必须让主会话可以直接续投：明确写出已完成事项、已更新的计划步骤和状态、下一个可验证动作、剩余风险、等待对象以及是否仍可推进。",
    "回传阶段结果不代表本协助任务永久结束。只要计划未完成、未暂停且没有真实阻塞，主会话会继续向本 taskBinding 续投；收到续投后继续原计划和原上下文，不新建替代任务。",
    `计划接口：${managerBaseUrl}/api/roles/${encodeURIComponent(input.roleId)}/plans`,
    `主会话续投接口：${managerBaseUrl}/api/agent/threads（action=send，threadId=${input.sourceThreadId}）`,
    "需要修改代码、资源、配置、外部系统、提交、发布或发送消息时，继续遵守计划中的动作级审批；不要因为是协助会话而扩大授权。",
    "收到任务后先读取对应计划和相关必读资料，再按计划当前步骤推进；不要只复述提醒，也不要仅因一轮结束就把整个计划标记为完成。"
  ].join("\n");
}
