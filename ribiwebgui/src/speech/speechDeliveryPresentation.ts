import type { SpeechHistoryItem, SpeechMessageResult } from "@shared/speechControlContract";

export type SpeechDeliveryPresentation = {
  label: string;
  color: "success" | "warning" | "error" | "grey";
};

export function speechHistoryDeliveryPresentation(item: SpeechHistoryItem): SpeechDeliveryPresentation {
  if (item.deliveryStatus === "delivered") return { label: "Desktop 已接收", color: "success" };
  if (item.deliveryStatus === "recorded") return { label: "仅记录，未唤醒", color: "warning" };
  if (item.deliveryStatus === "failed" || item.submitError) return { label: "投递失败", color: "error" };
  if (item.submitted) return { label: "状态未知（旧版）", color: "grey" };
  return { label: "仅转写", color: "grey" };
}

export function speechMessageResultText(result: SpeechMessageResult): string {
  if (result.status === "delivered") {
    return result.routeId
      ? `Desktop 目标任务已接收：${result.routeId}`
      : result.detail || "语音已广播到订阅 Route。";
  }
  if (result.status === "recorded") return `已记录，未唤醒 Agent：${result.reason || "关键词未命中"}`;
  return `投递失败：${result.detail || result.reason || "未知错误"}`;
}
