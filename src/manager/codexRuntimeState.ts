export const CODEX_DESKTOP_CHANNEL = "desktop-ipc";
export const CHATGPT_DESKTOP_HOST_NAME = "Codex/ChatGPT Desktop";

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const currentCodexReportKeys = [
  "monitorThreadId",
  "monitorThreadName",
  "monitorThreadCwd",
  "monitorThreadUpdatedAt",
  "monitorThreadSource",
  "lastAutoDiscoveryAt",
  "notificationCount",
  "lastNotificationAt",
  "lastNotificationError",
  "lastNotificationErrorAt",
  "lastDeliveryAcceptedAt",
  "reportGeneration",
  "reportSequence",
  "updatedAt"
] as const;

function currentCodexReport(state: Record<string, unknown>): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const key of currentCodexReportKeys) {
    if (Object.hasOwn(state, key)) selected[key] = state[key];
  }
  return selected;
}

export function resolveCodexRuntimeState(
  discoveredState: Record<string, unknown>,
  reportedState: Record<string, unknown>
): Record<string, unknown> {
  const currentReportedState = currentCodexReport(reportedState);
  const merged: Record<string, unknown> = {
    ...discoveredState,
    ...currentReportedState,
    agentAdapterType: "codex",
    deliveryTransport: CODEX_DESKTOP_CHANNEL,
    desktopHostName: CHATGPT_DESKTOP_HOST_NAME,
    desktopHostRequired: true
  };
  const lastNotificationAt = nonEmptyString(merged.lastNotificationAt);
  const lastNotificationError = nonEmptyString(merged.lastNotificationError);
  const monitorThreadId = nonEmptyString(merged.monitorThreadId);

  if (lastNotificationError) {
    return {
      ...merged,
      bound: false,
      deliveryHealthy: false,
      lastDeliveryChannel: CODEX_DESKTOP_CHANNEL,
      message: `Codex Desktop 投递失败：${lastNotificationError}`
    };
  }

  if (lastNotificationAt) {
    return {
      ...merged,
      bound: Boolean(monitorThreadId),
      deliveryHealthy: true,
      lastDeliveryChannel: CODEX_DESKTOP_CHANNEL,
      message: monitorThreadId
        ? "消息已由 Codex Desktop owner 接收，并在桌面任务中实时显示。"
        : "Codex Desktop 已接受最近投递，但尚未上报任务标识。"
    };
  }

  return {
    ...merged,
    bound: false,
    deliveryHealthy: false
  };
}
