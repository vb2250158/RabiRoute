import type { GatewayDefinition, NotificationRule, PersonaAutomationRuleDefinition } from "../../../../../ribiwebgui/src/types";
import { automationRulesForGateway, defaultHeartbeatSchedule, syncAutomationRuleProjection } from "../../../../../ribiwebgui/src/utils/gatewayHelpers";
import { browserUuid } from "../../../../../ribiwebgui/src/browserUuid";

type AutomationTriggerType = PersonaAutomationRuleDefinition["trigger"]["type"];
type AutomationActionType = PersonaAutomationRuleDefinition["action"]["type"];

export function newAutomationDraft(gateway: GatewayDefinition, triggerType: AutomationTriggerType, actionType: AutomationActionType): PersonaAutomationRuleDefinition {
  return {
    id: `automation-${browserUuid()}`,
    name: triggerType === "schedule" ? "新定时任务" : "新消息动作",
    enabled: true,
    trigger: triggerType === "schedule"
      ? { type: "schedule", schedule: defaultHeartbeatSchedule(gateway, "触发时间") }
      : { type: "message", routeKinds: [], targetGroupId: "", allowedSpeakerNames: [], regex: "" },
    action: actionType === "run_script"
      ? { type: "run_script", scriptPath: "", arguments: [], timeoutSeconds: 300 }
      : { type: "deliver_agent", target: { kind: "recipient", recipientId: "primary" }, message: "", template: "" }
  };
}

export function applyAutomationPatch(current: PersonaAutomationRuleDefinition, patch: Partial<PersonaAutomationRuleDefinition>): PersonaAutomationRuleDefinition {
  const trigger = patch.trigger ?? current.trigger;
  return {
    ...current,
    ...patch,
    trigger: patch.enabled !== undefined && trigger.type === "schedule"
      ? { ...trigger, schedule: { ...trigger.schedule, enabled: patch.enabled } }
      : trigger,
    action: patch.action ?? current.action
  };
}

export function createRoleEditorActions(read: () => GatewayDefinition | null, touch: () => void, onChange?: (gateway: GatewayDefinition) => void) {
  const selectedGateway = { get value() { return read(); } };
  function updateRule(ruleIndex: number, patch: Partial<NotificationRule>): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    const automations = automationRulesForGateway(gateway);
    const entry = automations
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => rule.trigger.type === "message" && rule.action.type === "deliver_agent")[ruleIndex];
    if (!entry || entry.rule.trigger.type !== "message" || entry.rule.action.type !== "deliver_agent") return;
    entry.rule = {
      ...entry.rule,
      name: patch.name ?? entry.rule.name,
      enabled: patch.enabled ?? entry.rule.enabled,
      trigger: {
        ...entry.rule.trigger,
        routeKinds: patch.routeKinds ?? entry.rule.trigger.routeKinds,
        targetGroupId: patch.targetGroupId ?? entry.rule.trigger.targetGroupId,
        allowedSpeakerNames: patch.allowedSpeakerNames ?? entry.rule.trigger.allowedSpeakerNames,
        regex: patch.regex ?? entry.rule.trigger.regex
      },
      action: {
        ...entry.rule.action,
        template: patch.template ?? entry.rule.action.template
      }
    };
    automations[entry.index] = entry.rule;
    syncAutomationRuleProjection(gateway);
    onChange?.(gateway);
    touch();
  }

  function insertAutomation(draft: PersonaAutomationRuleDefinition): string | undefined {
    const gateway = selectedGateway.value;
    if (!gateway) return undefined;
    const automations = automationRulesForGateway(gateway);
    if (automations.some(rule => rule.id === draft.id)) return draft.id;
    automations.push(draft);
    syncAutomationRuleProjection(gateway);
    touch();
    return draft.id;
  }

  function addAutomation(triggerType: AutomationTriggerType, actionType: AutomationActionType): string | undefined {
    const gateway = selectedGateway.value;
    return gateway ? insertAutomation(newAutomationDraft(gateway, triggerType, actionType)) : undefined;
  }

  function updateAutomation(ruleId: string, patch: Partial<PersonaAutomationRuleDefinition>): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    const automations = automationRulesForGateway(gateway);
    const index = automations.findIndex(rule => rule.id === ruleId);
    if (index < 0) return;
    automations[index] = applyAutomationPatch(automations[index], patch);
    syncAutomationRuleProjection(gateway);
    touch();
  }

  function removeAutomation(ruleId: string): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    const automations = automationRulesForGateway(gateway);
    const index = automations.findIndex(rule => rule.id === ruleId);
    if (index < 0) return;
    automations.splice(index, 1);
    syncAutomationRuleProjection(gateway);
    touch();
  }

  return { updateRule, addAutomation, insertAutomation, updateAutomation, removeAutomation };
}
