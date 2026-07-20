import { indexLines, type RoleKnowledgeItemType, type RoleKnowledgeSnapshot } from "../roleKnowledge.js";

export type RoleKnowledgeContextView = {
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
    `- 查看/更新计划：GET ${base}/plans、GET ${base}/plans/{planId}、POST ${base}/plans、PATCH ${base}/plans/{planId}`,
    `- 查看记忆：GET ${base}/memory、GET ${base}/memory/recent、GET ${base}/memory/recent/{memoryId}、GET ${base}/memory/consolidated、GET ${base}/memory/consolidated/{memoryId}`,
    `- 查看角色技能：GET ${base}/skills、GET ${base}/skills/{skillId}`,
    `- 新增近期记忆：POST ${base}/memory/recent`,
    `- 更新指定近期记忆：PATCH ${base}/memory/recent/{memoryId}`,
    "- 按 ID 查看记忆会刷新 viewedAt；更新近期记忆会刷新 updatedAt 和 viewedAt；相关记忆进入处理前确认队列时会刷新 viewedAt"
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

export function requiredReadLines(items: RoleKnowledgeSnapshot["requiredReadItems"]): string[] {
  if (items.length === 0) {
    return [
      "本次没有高相关必读项。仍需先扫一遍上方可见的进行中计划、近期记忆和命中召回索引；如发现与当前处理有关的条目，请先按 ID 查询内容再行动。"
    ];
  }
  return [
    "以下条目与当前消息高相关。回复、发布任务、更新计划、写入记忆或执行外部动作之前，必须先按 GET 路径读取每一项内容；不要只凭标题行动。",
    "如果任一必读项无法读取或内容不足以确认，请说明上下文无法确认，或先向用户追问。",
    "",
    ...items.map((item) => `- ${item.id}：${item.title}（${requiredReadTypeLabel(item.type)}，score=${item.score}） GET ${item.endpoint}`)
  ];
}

export function buildRoleKnowledgeContextView(roleId: unknown, knowledge: RoleKnowledgeSnapshot): RoleKnowledgeContextView {
  return {
    activePlanIndex: indexLines(knowledge.activePlans),
    activeSkillIndex: skillIndexLines(roleId, knowledge.activeSkills),
    recentMemoryIndex: indexLines(knowledge.recentMemories),
    matchedIndex: indexLines(knowledge.matchedItems),
    matchedSkillIndex: skillIndexLines(roleId, knowledge.matchedSkills),
    requiredReadLines: requiredReadLines(knowledge.requiredReadItems),
    apiHintLines: planMemoryApiHint(roleId)
  };
}
