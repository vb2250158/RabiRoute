import type { NotificationRule } from "../config.js";
import type { ForwardRouteKind } from "./types.js";

export const PLAN_FEEDBACK_ROUTE_KIND = "plan_feedback" as const;
export const PLAN_FEEDBACK_RULE_ID = "plan-feedback";
export const MEMORY_CONSOLIDATION_TRIGGER_ID = "memory-consolidation";

const planFeedbackRule: NotificationRule = {
  id: PLAN_FEEDBACK_RULE_ID,
  name: "计划反馈",
  enabled: true,
  routeKinds: [PLAN_FEEDBACK_ROUTE_KIND],
  template: ""
};

const memoryConsolidationRule: NotificationRule = {
  id: MEMORY_CONSOLIDATION_TRIGGER_ID,
  name: "记忆沉淀",
  enabled: true,
  routeKinds: ["manual_trigger"],
  template: ""
};

/**
 * Manager-owned system events are delivered to an explicitly selected route.
 * They do not depend on user-editable message rules or create hidden persona configuration.
 */
export function systemEventRuleForRouteKind(routeKind: ForwardRouteKind, triggerId?: string): NotificationRule | undefined {
  if (routeKind === PLAN_FEEDBACK_ROUTE_KIND) return planFeedbackRule;
  if (routeKind === "manual_trigger" && triggerId === MEMORY_CONSOLIDATION_TRIGGER_ID) return memoryConsolidationRule;
  return undefined;
}
