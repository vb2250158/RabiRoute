export type AgentCommunicationMode = "explicit" | "ambient" | "heartbeat" | "internal";

const explicitMessageRouteKinds = new Set([
  "private",
  "direct_at",
  "direct_reply",
  "plan_feedback",
  "role_panel_message",
  "voice_transcript",
  "rabilink",
  "wecom_message",
  "weixin_message",
  "feishu_message"
]);

export function communicationModeForRouteKind(routeKind: unknown): AgentCommunicationMode {
  const normalized = String(routeKind || "").trim();
  if (normalized === "heartbeat") return "heartbeat";
  if (normalized === "group_message" || normalized === "indirect_reply") return "ambient";
  if (explicitMessageRouteKinds.has(normalized)) return "explicit";
  return "internal";
}

export function proactiveCommunicationPolicyLines(mode: AgentCommunicationMode): string[] {
  if (mode === "explicit") {
    return [
      "明确面向本角色的消息默认回复：说明理解、下一步和负责人。耗时任务先确认，后续只报进展、风险、等待或决定。",
      "纯结束语、重复消息、自身消息，或他人已完整回答且没有新增价值时保持安静，并记录原因。"
    ];
  }
  if (mode === "ambient") {
    return [
      "群聊出现行动分配、方向纠正、风险、后续承诺或新增事实时，简短回应并推进。没有新增价值时保持安静。",
      "版本、日期、审批、负责人、取消、延期等项目事实先核对并交回原计划或记忆。"
    ];
  }
  if (mode === "heartbeat") {
    return [
      "发现遗漏、进展、风险、等待或待决定项时推进或通知；没有变化时保持安静。"
    ];
  }
  return [
    "直接推进已授权任务；受阻时写明已完成项、下一步和等待条件。",
    "结果影响他人时按约定出口回传；没有新增事实、动作或决定时保持安静。"
  ];
}
