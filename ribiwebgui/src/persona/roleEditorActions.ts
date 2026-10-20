import type { GatewayDefinition, NotificationRule, PersonaAutomationRuleDefinition } from "../types";
import { automationRulesForGateway, syncAutomationRuleProjection } from "../utils/gatewayHelpers";

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

  function addAutomation(triggerType: "message" | "schedule", actionType: "deliver_agent" | "run_script"): string | undefined {
    const gateway = selectedGateway.value;
    if (!gateway) return undefined;
    const automations = automationRulesForGateway(gateway);
    const id = `automation-${Date.now().toString(36)}-${automations.length + 1}`;
    const next: PersonaAutomationRuleDefinition = {
      id,
      name: triggerType === "schedule" ? "新定时任务" : "新消息动作",
      enabled: true,
      trigger: triggerType === "schedule"
        ? {
          type: "schedule",
          schedule: {
            id: `schedule-${Date.now().toString(36)}`,
            name: "触发时间",
            enabled: true,
            type: "interval",
            intervalSeconds: Number(gateway.heartbeatIntervalSeconds || 900)
          }
        }
        : { type: "message", routeKinds: [], targetGroupId: "", allowedSpeakerNames: [], regex: "" },
      action: actionType === "run_script"
        ? { type: "run_script", scriptPath: "", arguments: [], timeoutSeconds: 300 }
        : { type: "deliver_agent", target: { kind: "recipient", recipientId: "primary" }, message: "", template: "" }
    };
    automations.push(next);
    syncAutomationRuleProjection(gateway);
    touch();
    return id;
  }

  function updateAutomation(ruleId: string, patch: Partial<PersonaAutomationRuleDefinition>): void {
    const gateway = selectedGateway.value;
    if (!gateway) return;
    const automations = automationRulesForGateway(gateway);
    const index = automations.findIndex(rule => rule.id === ruleId);
    if (index < 0) return;
    const current = automations[index];
    automations[index] = {
      ...current,
      ...patch,
      trigger: patch.trigger ?? current.trigger,
      action: patch.action ?? current.action
    };
    syncAutomationRuleProjection(gateway);
    touch();
  }

  function removeAutomation(ruleId: string): void {
    const gateway = selectedGateway.value;
    if (!gateway || ruleId === "role-panel-message") return;
    const automations = automationRulesForGateway(gateway);
    const index = automations.findIndex(rule => rule.id === ruleId);
    if (index < 0) return;
    automations.splice(index, 1);
    syncAutomationRuleProjection(gateway);
    touch();
  }

  return { updateRule, addAutomation, updateAutomation, removeAutomation };
}
