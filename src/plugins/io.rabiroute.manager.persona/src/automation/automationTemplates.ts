import type { PersonaAutomationRuleDefinition, PersonaAutomationActionDefinition } from "../../../../shared/gatewayConfigModel.js";
import { normalizeAgentDeliveryTarget } from "../../../../shared/agentDeliveryTarget.js";

export type AutomationTemplate = Readonly<{
  id: string;
  version: string;
  title: string;
  description: string;
  triggerType?: "message" | "schedule";
  action: Readonly<Extract<PersonaAutomationActionDefinition, { type: "deliver_agent" }> & { message: string }>;
  ownerPluginId?: string;
}>;
const ownerPluginId = "io.rabiroute.manager.persona";
export const BLANK_AUTOMATION_TEMPLATE_ID = ownerPluginId + ".blank";
function preset(id: string, title: string, description: string, message: string, triggerType: "message" | "schedule" = "schedule"): AutomationTemplate {
  return Object.freeze({ id: ownerPluginId + "." + id, version: "1.0.0", title, description, triggerType,
    action: Object.freeze({ type: "deliver_agent", message }), ownerPluginId });
}
export const DEFAULT_AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = Object.freeze([
  preset("memory-skills", "记忆整理与 Skill 维护", "整理当前角色记忆，对照 Skill，维护可复用经验。", [
    "整理当前角色在本轮范围内的记忆，并维护当前角色的 Skill。",
    "先按主题检索相关记忆和 Skill，再读取需要的正文与资料。",
    "核对重复、冲突、过期内容及其来源，按现有记忆合同完成整理。",
    "将可复用方法与已有 Skill 对照。已有对应 Skill 就更新原 Skill，形成新的稳定流程就创建 Skill。",
    "检查 Skill 的名称、适用场景、步骤、引用和示例与当前真实接口一致。",
    "通过统一接口保存并回读，保留原请求、版本和回执。",
    "返回处理范围、记忆处理结果、Skill 变更清单、无变更结论及失败原因。"
  ].join("\n")),
  preset("work-review", "阶段复盘与记忆记录", "将工作结果、决定和用户纠正中的长期事实记入当前角色。", "读取本轮配置范围内的工作结果、决定和用户纠正。先检索已有记忆，复用同主题记录，保存有长期价值的新事实与来源。回读写入结果，并汇总新增、更新、无变更和失败项。"),
  preset("plan-review", "计划进展核对", "核对计划步骤、执行任务与原回执。", "读取配置范围内的计划、当前步骤、绑定任务和原回执，核对实际进展。按真实结果更新本次记录，列出明确待办和等待原因，保留原任务及投递编号。"),
  preset("message-summary", "消息摘要", "汇总所选渠道和时间范围的消息。", "读取配置渠道及本轮时间范围内的消息，按主题整理摘要，标出时间、来源、待办和查询覆盖范围，将结果交给本规则指定的投递目标。"),
  preset("runtime-review", "运行状态巡检", "汇总宿主、插件和目标设备的运行状态。", "读取当前宿主、插件和规则指定设备的状态，汇总异常、可定位的原诊断入口和正常项目。按各接口实际状态报告，保存本轮检查范围和时间。"),
  preset("blank", "空白消息投递", "填写要投递的内容，并选择触发条件和目标。", "", "message")
]);

/** A template expands into ordinary rule fields; later catalog updates do not rewrite the rule. */
export function automationTemplatePatch(template: AutomationTemplate): Partial<PersonaAutomationRuleDefinition> {
  return { name: template.title, action: { ...structuredClone(template.action), target: normalizeAgentDeliveryTarget(template.action.target) } };
}
function normalizedTemplate(value: unknown): AutomationTemplate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.trim() || typeof raw.version !== "string" || !raw.version
    || typeof raw.title !== "string" || !raw.title || raw.description !== undefined && typeof raw.description !== "string"
    || raw.triggerType !== undefined && raw.triggerType !== "message" && raw.triggerType !== "schedule") return undefined;
  const source = raw.action && typeof raw.action === "object" && !Array.isArray(raw.action)
    ? raw.action as Record<string, unknown> : { type: "deliver_agent", message: raw.message ?? "", template: raw.template };
  if (source.type !== "deliver_agent" || source.message !== undefined && typeof source.message !== "string"
    || source.template !== undefined && typeof source.template !== "string") return undefined;
  let target;
  try { target = normalizeAgentDeliveryTarget(source.target); }
  catch { return undefined; }
  return { id: raw.id, version: raw.version, title: raw.title, description: raw.description ?? "",
    ...(raw.triggerType === undefined ? {} : { triggerType: raw.triggerType }),
    action: { ...structuredClone(source), type: "deliver_agent", target, message: typeof source.message === "string" ? source.message : "" } as AutomationTemplate["action"],
    ...(typeof raw.ownerPluginId === "string" ? { ownerPluginId: raw.ownerPluginId } : {}) };
}
export function automationTemplateCatalog(additional: readonly unknown[] = []): { items: AutomationTemplate[]; warnings: string[] } {
  const items = new Map(DEFAULT_AUTOMATION_TEMPLATES.map(item => [item.id, item]));
  const warnings: string[] = [];
  for (let index = 0; index < additional.length; index++) {
    const template = normalizedTemplate(additional[index]);
    if (!template) { warnings.push("AUTOMATION_TEMPLATE_INVALID:" + index); continue; }
    if (!items.has(template.id)) items.set(template.id, template);
  }
  return { items: [...items.values()], warnings };
}
