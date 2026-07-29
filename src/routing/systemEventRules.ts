import type { NotificationRule } from "../config.js";
import type { ForwardRouteKind } from "./types.js";

export const PLAN_FEEDBACK_ROUTE_KIND = "plan_feedback" as const;
export const PLAN_FEEDBACK_RULE_ID = "plan-feedback";

const planFeedbackRule: NotificationRule = {
  id: PLAN_FEEDBACK_RULE_ID,
  name: "计划反馈",
  enabled: true,
  routeKinds: [PLAN_FEEDBACK_ROUTE_KIND],
  template: ""
};

/**
 * Manager-owned system events are delivered to an explicitly selected route.
 * They do not depend on user-editable message rules or create hidden persona configuration.
 */
export function systemEventRuleForRouteKind(routeKind: ForwardRouteKind): NotificationRule | undefined {
  return routeKind === PLAN_FEEDBACK_ROUTE_KIND ? planFeedbackRule : undefined;
}
