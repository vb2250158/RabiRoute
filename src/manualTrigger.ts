import { forwardMessageAndWait, type ForwardRouteKind } from "./forwarding.js";
import { appendManualTriggerEvent, type ManualTriggerRecord } from "./history.js";

export async function triggerManualRule(
  triggerId: string,
  message: string,
  triggerName = triggerId,
  routeKind: ForwardRouteKind = "manual_trigger",
  triggerRuleId?: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const record: ManualTriggerRecord = {
    time: now,
    rawMessage: message,
    messageId: `manual-trigger-${now}-${triggerId}`,
    senderName: "RabiRoute 手动触发",
    triggerId,
    triggerName,
    intervalSeconds: routeKind === "heartbeat" ? Number(process.env.HEARTBEAT_INTERVAL_SECONDS ?? "0") || undefined : undefined
  };

  appendManualTriggerEvent(record);
  await forwardMessageAndWait(routeKind, record, triggerRuleId ? { triggerRuleId } : {});
}
