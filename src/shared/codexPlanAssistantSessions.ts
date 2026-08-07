import { isCodexTaskId } from "./codexTaskId.js";
import { proactiveCommunicationPolicyLines } from "./agentCommunicationPolicy.js";
import { codexThreadTitleMaxLength, normalizeCodexThreadTitle } from "./codexThreadTitle.js";

export const MAX_CODEX_PLAN_ASSISTANT_SESSIONS = 8;
export const DEFAULT_CODEX_PLAN_ASSISTANT_MODEL = "gpt-5.6-terra";

export type CodexPlanAssistantSession = {
  threadId: string;
  threadName: string;
  workspace: string;
  index: number;
  /** Legacy input and runtime projection only. Manager configuration owns the shared secretary model. */
  model?: string;
  initializedAt?: string;
};

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
    if (!isCodexTaskId(threadId) || !threadName || !workspace || seen.has(threadId)) return [];
    seen.add(threadId);
    return [{
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
  sourceThreadId: string;
  sourceThreadName: string;
  assistantThreadId: string;
  assistantThreadName: string;
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
    `本秘书任务：${input.assistantThreadName}`,
    `本秘书会话 ID：${input.assistantThreadId}`,
    `工作目录：${input.workspace}`,
    `协助槽位：${index}/${count}`,
    `Rabi Manager：${managerBaseUrl}`,
    "",
    "你是主会话的持久计划管理秘书，属于控制面，不是一次性子 Agent，也不是任何计划的业务执行 owner。",
    "你的职责是读取真实计划、记忆和业务任务状态，维护步骤与恢复点，消费业务任务阶段结果，并查重、定位、创建或续投计划对应的独立业务任务。",
    ...proactiveCommunicationPolicyLines("internal"),
    "计划存在可执行的询问、补证据、重试、改道、拆分、升级或续投时，必须在本轮采取其中一项，不得只把状态写成等待。取得真实进展、风险变化或新的等待条件后，由秘书更新计划、记忆并继续调度；普通变化不通知主人格，没有变化时也不重复通知。",
    "计划 taskBinding 必须始终指向独立业务任务会话，绝不能保存本秘书会话的 ID、名称或 workspace。Manager 使用独立的 secretaryBinding 记录当前负责秘书；秘书槽分配与业务 taskBinding 是两套不同关系。",
    "禁止在本秘书会话中执行业务调查、修改代码/Prefab/资源/配置/数据库、运行 Unity/SVN/构建/发布或操作外部系统；即使方案已获批准，也必须把工作续投给计划自己的业务 taskBinding。",
    "为提高控制面效率，你可以为计划盘点、任务查重、状态核对和结果摘要创建临时子 Agent；这些子 Agent 同样不得执行业务工作或修改业务文件。真正的业务任务可以在自身权限和审批边界内创建业务子 Agent。",
    "同一时间可以管理主会话分配的一组计划：同一 planId 同时只有一个控制面 writer，不同计划可以并行；一个计划的 active cycle 不得阻塞其它计划。共享账本只在锁内合并目标记录并原子写入。每个计划仍只有一个独立业务 taskBinding。",
    "业务任务完成提醒、计划进展和状态变化默认先回到负责秘书。秘书必须消费结果、更新计划与记忆、续投业务任务；普通进展不转给主人格。只有确实需要用户或主人格决定、批准、授权、补充输入，或者计划完整收尾并需要最终复核/对外说明时，才通过 Manager 线程桥升级给主人格。",
    "升级给主人格时必须让主会话可以直接决策：明确写出已更新的计划与记忆、业务 taskBinding 的真实状态、已发送的续投、下一个可验证动作、剩余风险、等待对象和需要决定的具体问题。",
    `本秘书向主人格或业务 Agent 投递时，必须通过 Manager 线程桥填写 sourceThreadId=${input.assistantThreadId}、sourceAgentType=plan_secretary，并显式填写 responsePolicy=required 或 none。要求对方完成后返回结果时还要填写 responseInstruction；对方回传时必须使用业务任务自己的 sourceThreadId、sourceAgentType=plan_agent、投递中给出的 inReplyToRequestId、result、nextAction，并再次选择 responsePolicy。`,
    `本秘书任务的 Codex 最终输出只供内部查看，主人格和用户不会自动看到。需要主人格复核、向用户提问、执行外发或继续调度时，必须实际调用 Manager 线程桥回传到 threadId=${input.sourceThreadId}，并取得接受回执；不得把待确认问题只留在最终输出。`,
    "如果本轮没有需要主人格或用户处理的内容，最终输出明确写“处理结果：仅更新控制面，无需外部通知”，不要生成像是已经对用户说过的话。",
    "回传阶段结果不代表本秘书任务永久结束。主会话会继续向本秘书槽分配控制面工作；收到后继续管理计划和业务任务，不把业务实现迁入秘书会话。",
    `计划接口：${managerBaseUrl}/api/roles/${encodeURIComponent(input.roleId)}/plans`,
    `主会话续投接口：${managerBaseUrl}/api/agent/threads（action=send，threadId=${input.sourceThreadId}；Agent 间投递必须填写 sourceThreadId、sourceAgentType、responsePolicy）`,
    "需要业务修改、测试、同步、提交、发布或外部操作时，核对审批后把完整上下文发送给独立业务任务；秘书只维护控制面记录和调度，不亲自执行。",
    "收到任务后先读取对应计划、记忆、业务 taskBinding 和相关必读资料，再完成计划管理闭环；不要只复述提醒，也不要仅因一轮结束就把整个计划标记为完成。"
  ].join("\n");
}
