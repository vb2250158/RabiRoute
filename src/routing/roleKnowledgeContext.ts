import {
  indexLines,
  type RoleContextInjectionMode,
  type RoleKnowledgeItemType,
  type RoleKnowledgeSnapshot
} from "../roleKnowledge.js";

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

/** Stable discovery protocol; active operations and their inputs come from Manager. */
export function planMemoryApiHint(roleId: unknown): string[] {
  return [
    "可用 API 提示",
    `当前角色为 ${String(roleId || ":roleId")}。先核对动态 Manager 身份，再用 GET /api/search?q=<关键词> 检索本次任务，读取 label、excerpt、coverage 和 handle。`,
    "执行功能前，按 scope=operations 或 GET /api/agent/operations 发现接口。用返回的 operationId 读取 /api/agent/operations/{operationId}?view=input，沿 inputSources、relatedOperations 和 examples 取得实际参数。",
    "按当前授权调用合同指定的业务接口，再按实际结果、回执和写后回读确认完成。写入沿用动态 Manager 身份、Idempotency-Key 和适用的强 ETag / If-Match。",
    "局部来源或操作失败时保留错误与原回执，继续其它可用入口。不确定写入先查原 ID。发现、连接或检索工具不可用时记录一次实际错误，继续原任务。",
    "配置和业务操作优先使用已发现且可调用的 API。遇到明确的宿主能力缺口时，按当前授权选择适用工具。"
  ];
}

function focusedApiHint(roleId: unknown, interfaceDocPath: string): string[] {
  return [...planMemoryApiHint(roleId), `专题文档 ${interfaceDocPath} 按需补充背景，当前输入与恢复步骤以活动接口合同为准。`];
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
    "以下条目与当前消息高相关。需要其中的事实或流程时，按 GET 路径读取原文并确认适用范围。",
    "读取失败时记录一次实际原因，利用其它可用资料继续原任务；涉及该条目且缺少依据的事实标明未确认。确需用户决定的业务问题再询问。",
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
    return {
      mode,
      activePlanIndex: "",
      activeSkillIndex: "",
      recentMemoryIndex: "",
      matchedIndex: "",
      matchedSkillIndex: "",
      requiredReadLines: requiredReadLines(knowledge.requiredReadItems, mode),
      apiHintLines: focusedApiHint(roleId, knowledge.agentInterfaceDocPath || "docs/rabi-agent-interfaces.md")
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
