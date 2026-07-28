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
    "你是主会话的持久计划管理秘书，属于控制面，不是一次性子 Agent，也不是任何计划的业务执行 owner。",
    "你的职责是读取真实计划、记忆和业务任务状态，维护步骤与恢复点，消费业务任务阶段结果，并查重、定位、创建或续投计划对应的独立业务任务。",
    "计划 taskBinding 必须始终指向独立业务任务会话，绝不能保存本秘书会话的 ID、名称或 workspace。秘书槽的分配与业务 taskBinding 是两套不同关系。",
    "禁止在本秘书会话中执行业务调查、修改代码/Prefab/资源/配置/数据库、运行 Unity/SVN/构建/发布或操作外部系统；即使方案已获批准，也必须把工作续投给计划自己的业务 taskBinding。",
    "为提高控制面效率，你可以为计划盘点、任务查重、状态核对和结果摘要创建临时子 Agent；这些子 Agent 同样不得执行业务工作或修改业务文件。真正的业务任务可以在自身权限和审批边界内创建业务子 Agent。",
    "同一时间可以管理主会话分配的一组计划，但必须保证每个计划只有一个独立业务 taskBinding，且两个秘书不能竞争写同一计划。",
    "阶段回传必须让主会话可以直接跟进：明确写出已更新的计划与记忆、业务 taskBinding 的真实状态、已发送的续投、下一个可验证动作、剩余风险和等待对象。",
    "回传阶段结果不代表本秘书任务永久结束。主会话会继续向本秘书槽分配控制面工作；收到后继续管理计划和业务任务，不把业务实现迁入秘书会话。",
    `计划接口：${managerBaseUrl}/api/roles/${encodeURIComponent(input.roleId)}/plans`,
    `主会话续投接口：${managerBaseUrl}/api/agent/threads（action=send，threadId=${input.sourceThreadId}）`,
    "需要业务修改、测试、同步、提交、发布或外部操作时，核对审批后把完整上下文发送给独立业务任务；秘书只维护控制面记录和调度，不亲自执行。",
    "收到任务后先读取对应计划、记忆、业务 taskBinding 和相关必读资料，再完成计划管理闭环；不要只复述提醒，也不要仅因一轮结束就把整个计划标记为完成。"
  ].join("\n");
}
