import type { VoiceTranscriptEventRecord } from "./history.js";
import type { ForwardTemplateValues } from "./routing/types.js";
import type { WearableHealthAlert } from "./wearableHealth.js";

export type WearableHealthAlertDeliveryContext = {
  agentRoleId: string;
  managerPort: string | number;
  sourceDeviceId?: string;
  sourceDeviceName?: string;
  sourceDeviceKind?: string;
  transport?: string;
};

/**
 * Converts a persisted health alert into the ordinary routing record used by
 * Agent adapters. Persistence remains owned by wearableHealth.ts; this module
 * only owns the delivery projection.
 */
export function buildWearableHealthAlertRecord(
  alert: WearableHealthAlert,
  context: WearableHealthAlertDeliveryContext
): VoiceTranscriptEventRecord {
  const roleId = encodeURIComponent(context.agentRoleId);
  const base = `http://127.0.0.1:${context.managerPort}/api/roles/${roleId}/health`;
  return {
    time: Math.floor(Date.parse(alert.createdAt) / 1000),
    rawMessage: `${alert.message}\n健康数据已记录。当前状态：GET ${base}/state；历史：GET ${base}/history；摘要：GET ${base}/summary。`,
    messageId: alert.id,
    senderName: context.sourceDeviceName || "智能手表/手环",
    adapterType: "wearable",
    source: "wearable-health",
    sourceDeviceId: context.sourceDeviceId,
    sourceDeviceName: context.sourceDeviceName,
    sourceDeviceKind: context.sourceDeviceKind || "wearable",
    transport: context.transport || "rabilink",
    routeProfileId: context.agentRoleId
  };
}

export function wearableHealthAlertTemplateValues(alert: WearableHealthAlert): ForwardTemplateValues {
  return {
    inputAdapter: "wearable",
    healthAlertType: alert.type,
    healthMetric: alert.sample.metric,
    heartRateBpm: alert.sample.value,
    sleepState: alert.sample.sleepState,
    sourceDeviceId: alert.sample.sourceDeviceId
  };
}
