import type { NotificationRule } from "../config.js";
import type { ForwardRouteKind, ForwardTemplateValues } from "./types.js";

export const PLAN_FEEDBACK_ROUTE_KIND = "plan_feedback" as const;
export const PLAN_FEEDBACK_RULE_ID = "plan-feedback";
export const MEMORY_CONSOLIDATION_TRIGGER_ID = "memory-consolidation";

const planFeedbackRule: NotificationRule = {
  id: PLAN_FEEDBACK_RULE_ID,
  name: "计划反馈",
  enabled: true,
  routeKinds: [PLAN_FEEDBACK_ROUTE_KIND],
  agentTarget: { kind: "recipient", recipientId: "primary" },
  template: ""
};

/**
 * Manager-owned system events are delivered to an explicitly selected route.
 * They do not depend on user-editable message rules or create hidden persona configuration.
 */
export function systemEventRuleForRouteKind(
  routeKind: ForwardRouteKind,
  triggerId?: string,
  extraValues: ForwardTemplateValues = {}
): NotificationRule | undefined {
  if (routeKind === PLAN_FEEDBACK_ROUTE_KIND) return planFeedbackRule;
  if (routeKind === "heartbeat" && typeof extraValues.automationRuleId === "string" && extraValues.automationRuleId.trim()) {
    return {
      id: extraValues.automationRuleId.trim(),
      name: typeof extraValues.automationRuleName === "string" && extraValues.automationRuleName.trim()
        ? extraValues.automationRuleName.trim()
        : "人格定时任务",
      enabled: true,
      routeKinds: ["heartbeat"],
      template: typeof extraValues.automationTemplate === "string" ? extraValues.automationTemplate : ""
    };
  }
  return undefined;
}
