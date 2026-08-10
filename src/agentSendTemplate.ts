export function agentSendRequestTemplateForSource(context: Record<string, unknown>): Record<string, unknown> | undefined {
  const routeId = String(context.routeProfileId || context.routeId || "").trim();
  const targetType = String(context.targetType || "").trim();
  const adapterType = String(context.adapterType || "").trim();
  const outputAdapter = String(context.outputAdapter || "").trim();
  const channel = targetType === "plan_feedback"
    ? "plan_feedback"
    : targetType === "role_panel" || adapterType === "rolePanel"
      ? "role_panel"
      : targetType === "rabilink" || adapterType === "rabilink"
        ? "rabilink"
        : adapterType === "wecom"
          ? "wecom"
          : adapterType === "weixin"
            ? "weixin"
            : adapterType === "feishu"
              ? "feishu"
              : adapterType === "speech"
                ? "speech"
                : adapterType === "fennenote"
                  ? (outputAdapter === "tts" ? "speech" : "fennenote")
                  : targetType === "group" || targetType === "private"
                    ? "napcat"
                    : undefined;
  if (!routeId || !channel) return undefined;
  const params: Record<string, unknown> = channel === "napcat"
    ? {
        target: targetType,
        ...(targetType === "group" ? { groupId: context.groupId } : { userId: context.userId }),
        instanceId: context.instanceId,
        replyToMessageId: context.replyToSource === true ? context.messageId : undefined
      }
    : channel === "wecom"
      ? { chatId: context.wecomChatId ?? context.groupId, userId: context.userId, reqId: context.wecomReqId }
      : channel === "feishu"
        ? { chatId: context.feishuChatId ?? context.groupId, userId: context.userId }
        : channel === "weixin"
          ? { sessionId: context.weixinSessionId ?? context.sessionId, userId: context.weixinUserId ?? context.userId }
          : channel === "rabilink"
            ? {
                proactive: false,
                sourceMessageId: context.messageId,
                targetDeviceIds: context.targetDeviceIds,
                targetDeviceKinds: context.targetDeviceKinds
              }
            : channel === "speech"
              ? { sessionId: context.sessionId }
              : channel === "fennenote"
                ? { sessionId: context.sessionId, mode: "playback" }
                : channel === "role_panel"
                  ? { roleId: context.roleId, messageId: context.messageId }
                  : {
                      roleId: context.roleId,
                      planId: context.planId,
                      stepId: context.stepId,
                      feedbackId: context.planFeedbackId,
                      kind: context.planFeedbackKind === "guidance" ? "guidance" : "approval"
                    };
  return {
    deliveryId: "<为本次发送生成稳定 ID；重试时保持不变>",
    routeId,
    channel,
    params,
    payload: { type: "text", text: "<这里填写要发送的正文>" },
    ...(context.messageProcessingRequirementId
      ? { tracking: { requirementId: context.messageProcessingRequirementId } }
      : {})
  };
}
