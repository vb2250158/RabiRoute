import { forwardMessageAndWait, type ForwardDeliveryResult, type ForwardRouteKind } from "./forwarding.js";
import { appendManualTriggerEvent, type ManualTriggerRecord } from "./history.js";

export async function triggerManualRule(
  triggerId: string,
  message: string,
  triggerName = triggerId,
  routeKind: ForwardRouteKind = "manual_trigger",
  triggerRuleId?: string,
  triggerSource: "manual" | "auto" = "manual"
): Promise<ForwardDeliveryResult> {
  const now = Math.floor(Date.now() / 1000);
  const record: ManualTriggerRecord = {
    time: now,
    rawMessage: message,
    messageId: `manual-trigger-${now}-${triggerId}`,
    senderName: triggerSource === "auto" ? "RabiRoute 自动调度" : "RabiRoute 手动触发",
    triggerId,
    triggerName,
    triggerSource,
    intervalSeconds: routeKind === "heartbeat" ? Number(process.env.HEARTBEAT_INTERVAL_SECONDS ?? "0") || undefined : undefined
  };

  appendManualTriggerEvent(record);
  return forwardMessageAndWait(routeKind, record, triggerRuleId ? { triggerRuleId } : {});
}
