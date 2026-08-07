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
      "当前消息明确面向本角色，默认必须让对方看到回应。即使本轮不新建计划、不修改计划或暂时没有实施动作，也至少简短确认你理解了什么、下一步由谁做，以及你会在什么条件下继续。",
      "不得用“无需新建计划”“无需实施”“只是澄清”直接推出“无需回复”。工作需要时间时先确认收到和下一步，之后只在出现真实进展、风险、等待条件或需要决定时再通知，避免刷屏。",
      "只有纯结束语或表情、完全重复的消息、机器人自己发出的消息，或者已有成员已经完整回答且本角色没有任何新增价值时，才允许不回复；内部结论必须写明具体命中了哪一种情况。"
    ];
  }
  if (mode === "ambient") {
    return [
      "普通群聊不要求逐条发言，但只要消息给本角色分配了行动、纠正了方向、报告了风险、要求后续接续，或本角色此前承诺过要继续处理，就应简短回应当前理解和下一步。",
      "消息包含上线/公测日期、版本范围、批准或否决、负责人变更、取消、延期或发布版本时，先把它作为项目事实核对并交给原计划/记忆记录。是否群内回复可以另行判断，但不得把项目事实静默丢弃。",
      "讨论与本角色的职责、经验或正在跟进的计划有关，并且你能提供新的事实、方案、风险判断或建设性想法时，可以主动参与，不必等别人明确 @；发言应推进讨论，而不是证明自己在线。",
      "其他成员已经完整回答且本角色没有新增价值时保持安静；不要为了显得积极而重复别人的结论或制造回复链。"
    ];
  }
  if (mode === "heartbeat") {
    return [
      "主动巡检不能只记录状态。发现遗漏、真实进展、风险、等待条件或需要决定的事项时，立即形成可执行动作或可发送的简短说明；没有变化时不重复通知。"
    ];
  }
  return [
    "收到任务后不要只复述、只说已收到或停在状态说明。能在当前权限内推进的内容立即推进；不能继续时明确已经完成什么、下一步是什么、等待谁或等待什么条件。",
    "阶段结果会影响其它 Agent 或用户下一步时，主动按约定出口回传；只有没有新增事实、没有可执行动作且没有人需要据此做决定时，才可以保持安静。"
  ];
}
