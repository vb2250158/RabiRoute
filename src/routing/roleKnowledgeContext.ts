import {
  indexLines,
  type RoleContextInjectionMode,
  type RoleKnowledgeIndexItem,
  type RoleKnowledgeItemType,
  type RoleKnowledgeSnapshot
} from "../roleKnowledge.js";
import { roleStorageMutationContractLines } from "../shared/roleStorageMutationContract.js";

export type RoleKnowledgeContextView = {
  mode: RoleContextInjectionMode;
  activePlanIndex: string;
  activeSkillIndex: string;
  recentMemoryIndex: string;
  matchedIndex: string;
  matchedSkillIndex: string;
  requiredReadLines: string[];
  apiHintLines: string[];
};

export function roleApiBase(roleId: unknown): string {
  const id = String(roleId || ":roleId");
  return `/api/roles/${id === ":roleId" ? id : encodeURIComponent(id)}`;
}

export function planMemoryApiHint(roleId: unknown): string[] {
  const base = roleApiBase(roleId);
  return [
    "可用 API 提示：",
    "- 查询可联系人格：GET /api/personas?addressable=true；向其它人格投递：POST /api/personas/{personaId}/messages。请求必须带唯一 deliveryId，sourceRouteId 使用当前 replyContext.runtimeRouteId，sourceCapability 原样使用 replyContext.personaMessagingCapability；目标有多个已启用 Route 时必须明确提供 targetRouteId。回复时沿用 personaConversationId、把当前 messageId 写入 inReplyToMessageId，并将 personaMessageHopCount 加 1；不得超过 personaMessageMaxHops",
    `- 查看/更新计划：GET ${base}/plans、GET ${base}/plans/{planId}、POST ${base}/plans、PATCH ${base}/plans/{planId}`,
      "- 待审批计划如有实际效果图、演示视频、设计稿、报告或其它相关文件，应通过计划 POST/PATCH 的 attachments 一并提交：本机文件使用 path，内存内容使用 name/mimeType/contentBase64；不要只把文件路径写进标题、focus 或审批说明",
    "- 计划 status 是唯一状态真源，只能写分析中、待审批、执行中、等待打包、等待 QA、待讨论、暂停、完成、关闭；列表、详情和排序不会再从步骤文字派生另一套状态",
    "- archiveStatus 与 status 独立，只能写未归档或已归档；只有完成或关闭计划可以归档。已归档计划不参与关键词召回，只能按明确 planId 或归档视图读取",
    "- 审批前的调查、补证据、设计和审批准备使用 status=分析中；审批合同完整并正式等待回执时使用 status=待审批；审批通过或用户明确直接授权后的实施与开发验证使用 status=执行中。等待包体、QA、讨论或恢复时分别写对应状态",
    "- 用户要求暂停计划时，PATCH 顶层 status=暂停；恢复时按实际阶段改为分析中或执行中",
    "- 只有完整、可提交且 responseStatus=pending 的 approvalRequest 会由 Manager 自动派生阻塞；isBlocked 是兼容投影，不要手写。其它等待、失败和资源缺口必须继续询问、重试、改道、拆分或补证据",
    "- 请求审批前必须补齐 approvalRequest：approver、request、recommendation、alternatives、reason、files/commands/changes、validation、rollback、outOfScope、requestedAt、sourceMessageId 或 feedbackId、responseStatus；信息不完整时计划保持分析中并禁止正式审批",
    `- 记录计划反馈：GET ${base}/plans/{planId}/feedback、POST ${base}/plans/{planId}/feedback；计划级引导用 kind=guidance 且不带 stepId，审批意见用 kind=approval_suggestion；QQ 等外部入口记录用户反馈时使用 author=user、source=qq、notifyAgent=false；Agent 处理说明分别用 kind=guidance_response / kind=approval_response、author=agent、notifyAgent=false`,
    "- 收到计划引导后，先 GET 当前计划和反馈，再按引导 PATCH 计划并在需要时调整未开始步骤，最后写 guidance_response；收到审批意见则更新对应计划/步骤和审批回执后写 approval_response。两者都不要只在 Agent 会话里直接回答",
    "- 审批意见只形成计划审计记录，不直接推进步骤；Agent 判断后必须另行 PATCH 对应计划；计划说明要具体到真实文件、完整命令、变更影响、验证、回退和排除范围",
    `- 查看记忆：GET ${base}/memory、GET ${base}/memory/recent、GET ${base}/memory/recent/{memoryId}、GET ${base}/memory/consolidated、GET ${base}/memory/consolidated/{memoryId}`,
    `- 查看角色技能：GET ${base}/skills、GET ${base}/skills/{skillId}`,
    `- 新增近期记忆：POST ${base}/memory/recent`,
    `- 更新指定近期记忆：PATCH ${base}/memory/recent/{memoryId}`,
    ...roleStorageMutationContractLines(base),
    "- 按 ID 查看记忆会刷新 viewedAt；更新近期记忆会刷新 updatedAt 和 viewedAt；相关记忆进入处理前确认队列时会刷新 viewedAt"
  ];
}

function focusedApiHint(roleId: unknown): string[] {
  const base = roleApiBase(roleId);
  return [
    "计划、记忆和技能默认只注入与当前输入高相关的摘要；长历史与完整内容按需查询。",
    `按需查询/维护：${base}/plans、${base}/memory、${base}/skills；执行写入前仍须遵守对应接口校验与 Action Gate。`,
    "计划 status 是唯一状态真源，只能写分析中、待审批、执行中、等待打包、等待 QA、待讨论、暂停、完成、关闭。审批准备使用分析中，正式等待审批回执使用待审批，审批通过或用户直接授权实施后使用执行中；列表和详情不会再派生第二套状态。",
    "archiveStatus 独立使用未归档或已归档；已归档计划不参与关键词召回，只能按明确 planId 或归档视图读取。",
    "需要联系其它人格时，先 GET /api/personas?addressable=true，再 POST /api/personas/{personaId}/messages；请求带唯一 deliveryId，sourceRouteId 使用当前 replyContext.runtimeRouteId，sourceCapability 原样使用 personaMessagingCapability。多目标 Route 必须明确选择；回复沿用会话 ID、引用当前消息并增加 hopCount，不得超过注入上限。",
      "待审批计划如果已有实际效果图、演示视频、设计稿、报告或其它文件，应写入计划 attachments；可传本机 path 或 name/mimeType/contentBase64，页面会展示附件并支持图片、视频预览。",
    ...roleStorageMutationContractLines(base)
  ];
}

function requiredReadTypeLabel(type: RoleKnowledgeItemType): string {
  if (type === "plan") return "计划";
  if (type === "recent_memory") return "近期记忆";
  if (type === "consolidated_memory") return "沉淀记忆";
  if (type === "role_skill") return "角色技能";
  return type;
}

export function skillIndexLines(roleId: unknown, items: Array<{ id: string; title: string; summary: string }>): string {
  if (items.length === 0) return "- 暂无";
  const base = roleApiBase(roleId);
  return items.map((item) => `- ${item.id}：${item.title} - ${item.summary}（GET ${base}/skills/${encodeURIComponent(item.id)}）`).join("\n");
}

function summarizedIndexLines(items: RoleKnowledgeIndexItem[], empty = "- 暂无高相关项"): string {
  if (items.length === 0) return empty;
  return items.map((item) => {
    const summary = String(item.summary || "").trim();
    return `- [${requiredReadTypeLabel(item.type)}] ${item.id}：${item.title}${summary ? ` — ${summary}` : ""}`;
  }).join("\n");
}

export function requiredReadLines(
  items: RoleKnowledgeSnapshot["requiredReadItems"],
  mode: RoleContextInjectionMode = "legacy"
): string[] {
  if (items.length === 0) {
    return mode === "focused"
      ? [
          "本次没有高相关必读项；不要预加载全量历史。出现明确历史指代、既有承诺、计划、偏好或证据需求时，再按 ID 或 API 按需查询。"
        ]
      : [
          "本次没有高相关必读项。仍需先扫一遍上方可见的当前计划、近期记忆和命中召回索引；如发现与当前处理有关的条目，请先按 ID 查询内容再行动。"
        ];
  }
  return [
    "以下条目与当前消息高相关。回复、发布任务、更新计划、写入记忆或执行外部动作之前，必须先按 GET 路径读取每一项内容；不要只凭标题行动。",
    "如果任一必读项无法读取或内容不足以确认，请说明上下文无法确认，或先向用户追问。",
    "",
    ...items.map((item) => {
      const summary = String(item.summary || "").trim();
      return `- ${item.id}：${item.title}${summary ? ` — ${summary}` : ""}（${requiredReadTypeLabel(item.type)}，score=${item.score}） GET ${item.endpoint}`;
    })
  ];
}

export function buildRoleKnowledgeContextView(roleId: unknown, knowledge: RoleKnowledgeSnapshot): RoleKnowledgeContextView {
  const mode = knowledge.contextInjection?.mode ?? "legacy";
  if (mode === "focused") {
    const base = roleApiBase(roleId);
    const requiredSkillIds = new Set(
      knowledge.requiredReadItems
        .filter((item) => item.type === "role_skill")
        .map((item) => item.id)
    );
    return {
      mode,
      activePlanIndex: `- 默认不注入全量计划索引；按需查询 GET ${base}/plans`,
      activeSkillIndex: `- 默认不注入全量技能索引；按需查询 GET ${base}/skills`,
      recentMemoryIndex: `- 默认不注入全量记忆索引；按需查询 GET ${base}/memory`,
      matchedIndex: summarizedIndexLines(knowledge.requiredReadItems.filter((item) => item.type !== "role_skill")),
      matchedSkillIndex: skillIndexLines(
        roleId,
        knowledge.matchedSkills.filter((item) => requiredSkillIds.has(item.id))
      ),
      requiredReadLines: requiredReadLines(knowledge.requiredReadItems, mode),
      apiHintLines: focusedApiHint(roleId)
    };
  }
  return {
    mode,
    activePlanIndex: indexLines(knowledge.activePlans),
    activeSkillIndex: skillIndexLines(roleId, knowledge.activeSkills),
    recentMemoryIndex: indexLines(knowledge.recentMemories),
    matchedIndex: indexLines(knowledge.matchedItems),
    matchedSkillIndex: skillIndexLines(roleId, knowledge.matchedSkills),
    requiredReadLines: requiredReadLines(knowledge.requiredReadItems, mode),
    apiHintLines: planMemoryApiHint(roleId)
  };
}
