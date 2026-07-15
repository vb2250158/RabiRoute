export const CODEX_APP_SERVER_CHANNEL = "app-server-stdio";
export const CHATGPT_DESKTOP_HOST_NAME = "ChatGPT";

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
  "lastChatGptDesktopHostVisibilityAt",
  "lastChatGptDesktopHostVisibilityReason",
  "lastChatGptDesktopHostVisibilityMode",
  "lastChatGptDesktopHostVisibilityTarget",
  "lastChatGptDesktopHostVisibilityError",
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
    deliveryTransport: CODEX_APP_SERVER_CHANNEL,
    desktopHostName: CHATGPT_DESKTOP_HOST_NAME,
    desktopHostRequired: false
  };
  const lastNotificationAt = nonEmptyString(merged.lastNotificationAt);
  const lastNotificationError = nonEmptyString(merged.lastNotificationError);
  const monitorThreadId = nonEmptyString(merged.monitorThreadId);

  if (lastNotificationError) {
    return {
      ...merged,
      bound: false,
      deliveryHealthy: false,
      lastDeliveryChannel: CODEX_APP_SERVER_CHANNEL,
      message: `Codex app-server stdio 投递失败：${lastNotificationError}`
    };
  }

  if (lastNotificationAt) {
    return {
      ...merged,
      bound: Boolean(monitorThreadId),
      deliveryHealthy: true,
      lastDeliveryChannel: CODEX_APP_SERVER_CHANNEL,
      message: monitorThreadId
        ? "Codex 已通过 app-server stdio 投递；ChatGPT 桌面仅为可选宿主。"
        : "Codex 已通过 app-server stdio 接受最近投递，但尚未上报线程标识。"
    };
  }

  return {
    ...merged,
    bound: false,
    deliveryHealthy: false
  };
}
