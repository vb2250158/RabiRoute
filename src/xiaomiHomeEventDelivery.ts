import type { VoiceTranscriptEventRecord } from "./history.js";

export type XiaomiHomeEvent = {
  id: string;
  kind: "device_state_changed" | "device_offline" | "sensor_alert" | "camera_motion_detected" | "camera_clip_ready" | "action_completed" | "action_failed";
  resourceId: string;
  resourceName: string;
  areaName?: string;
  homeId?: string;
  occurredAt: string;
  summary: string;
  artifactId?: string;
};

export type XiaomiHomeEventDeliveryContext = {
  agentRoleId: string;
};

export function validateXiaomiHomeEvent(event: XiaomiHomeEvent): void {
  if (!String(event.id || "").trim()) throw new Error("Xiaomi Home event id is required.");
  if (!String(event.resourceId || "").startsWith("home:")) throw new Error("Xiaomi Home resourceId is invalid.");
  if (!String(event.resourceName || "").trim()) throw new Error("Xiaomi Home resourceName is required.");
  if (!Number.isFinite(Date.parse(event.occurredAt))) throw new Error("Xiaomi Home occurredAt is invalid.");
  if (!String(event.summary || "").trim()) throw new Error("Xiaomi Home summary is required.");
}

export function buildXiaomiHomeEventRecord(event: XiaomiHomeEvent): VoiceTranscriptEventRecord {
  validateXiaomiHomeEvent(event);
  return {
    time: Math.floor(Date.parse(event.occurredAt) / 1000),
    rawMessage: event.summary.trim(),
    messageId: event.id.trim(),
    senderName: event.resourceName.trim(),
    adapterType: "xiaomiHome",
    source: "xiaomiHome",
    sourceDeviceId: event.resourceId,
    sourceDeviceName: event.resourceName.trim(),
    sourceDeviceKind: event.kind.startsWith("camera_") ? "camera" : "xiaomi_device",
    sourceArea: event.areaName?.trim(),
    sessionId: event.homeId?.trim() || "xiaomi-home"
  };
}

export function xiaomiHomeEventTemplateValues(event: XiaomiHomeEvent): Record<string, string> {
  return {
    xiaomiEventKind: event.kind,
    xiaomiResourceId: event.resourceId,
    xiaomiResourceName: event.resourceName,
    xiaomiAreaName: event.areaName || "",
    xiaomiHomeId: event.homeId || "",
    xiaomiArtifactId: event.artifactId || ""
  };
}
