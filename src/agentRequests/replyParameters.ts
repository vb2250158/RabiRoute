import type { AgentCommunicationPreparation, AgentRequestRecord } from "./store.js";

export function agentReplyRequest({ source, target, requestId }: Pick<AgentCommunicationPreparation,
  "source" | "target" | "requestId">): Record<string, unknown> {
  if (source.connection) return {
    ...(source.connection.ledgerOwnerDeviceId ? { ledgerOwnerDeviceId: source.connection.ledgerOwnerDeviceId } : {}),
    action: "send", inReplyToRequestId: requestId, result: "<结果>", nextAction: "<下一步>", responsePolicy: "none",
    ...(target.agentAdapter && target.threadId ? { sourceThreadId: target.threadId, sourceAgentType: target.agentType || "agent",
      messageSource: { type: "agent", agentAdapter: target.agentAdapter, sessionId: target.threadId,
        sessionName: target.threadName || target.threadId, workspace: target.workspace } } : {})
  };
  return {
    ...(source.endpoint?.ledgerOwnerDeviceId ? { ledgerOwnerDeviceId: source.endpoint.ledgerOwnerDeviceId }
      : source.endpoint?.ownerDeviceId && source.endpoint.ownerDeviceId !== target.endpoint?.ownerDeviceId ? { ledgerOwnerDeviceId: source.endpoint.ownerDeviceId } : {}),
    action: "send", threadId: source.threadId, cwd: source.workspace, agentAdapter: source.agentAdapter ?? source.endpoint?.provider,
    ...(source.endpoint?.kind === "instance" || source.endpoint?.kind === "device" ? { instanceBinding: {
      instanceId: source.endpoint.instanceId, agentId: source.endpoint.agentId, ...(source.endpoint.ownerDeviceId ? { ownerDeviceId: source.endpoint.ownerDeviceId } : {})
    } } : {}),
    ...(source.endpoint?.kind === "local" || source.endpoint?.kind === "service" ? { agentTargetId: `local:${source.endpoint.provider}` } : {}),
    messageSource: { type: "agent", agentAdapter: target.agentAdapter,
      sessionId: target.threadId, sessionName: target.threadName || target.endpoint?.agentId || target.threadId, workspace: target.workspace },
    sourceThreadId: target.threadId, sourceAgentType: target.agentType || "agent",
    inReplyToRequestId: requestId,
    result: "<结果>", nextAction: "<下一步>", responsePolicy: "none"
  };
}

export function agentRequestReminderPrompt(request: AgentRequestRecord): string {
  return [
    "[Rabi Agent 请求回复提醒]",
    `原请求时间：${request.createdAt}`,
    `需要回答：${request.responseInstruction}`,
    "尚未记录正式回传；普通任务最终文字不替代接口回执。",
    "[回传参数]",
    JSON.stringify(request.source.connection ? { ...connectionRecordParameters(request.source, request.id, request.target),
      endpoint: "POST /api/agent/threads", request: agentReplyRequest({ source: request.source, target: request.target, requestId: request.id }) }
      : { requestId: request.id, endpoint: "POST /api/agent/threads", request: agentReplyRequest({ source: request.source, target: request.target, requestId: request.id }) }, null, 2),
    request.source.connection ? "需要继续投递时选择实际任务目标，连接回执仅记录原请求结果。" : "需要继续往返时填写 responsePolicy=required 和 responseInstruction。"
  ].join("\n");
}

function connectionRecordParameters(source: AgentCommunicationPreparation["source"], requestId: string, target: AgentCommunicationPreparation["target"]): Record<string, unknown> {
  const ledgerOwnerDeviceId = source.connection!.ledgerOwnerDeviceId;
  const crossPeer = ledgerOwnerDeviceId && target.endpoint?.ownerDeviceId && ledgerOwnerDeviceId !== target.endpoint.ownerDeviceId;
  const path = `/api/agent/requests/${encodeURIComponent(requestId)}`;
  return { requestId, managerInstanceId: source.connection!.managerInstanceId,
    record: { method: "GET", path: crossPeer ? `/api/rabilink/peer/http/${encodeURIComponent(ledgerOwnerDeviceId)}/manager${path}` : path,
      ...(ledgerOwnerDeviceId ? { ledgerOwnerDeviceId } : {}) },
    continuation: "来源是连接而非任务。保留原 requestId，在原 Manager 请求记录中查看处理结果；通过 /api/agent/threads 提交原 requestId 的结果，仅记录回执，不投递原生任务。" };
}

/** Delivery and reminders share one reply request schema; recovery uses durable evidence. */
export function agentReplyParameters(preparation: AgentCommunicationPreparation): Record<string, unknown> {
  return {
    deliveryId: preparation.deliveryId,
    responsePolicy: preparation.responsePolicy,
    ...(preparation.inReplyToRequestId ? { inReplyToRequestId: preparation.inReplyToRequestId } : {}),
    ...(preparation.requestId && preparation.source.connection ? {
      ...connectionRecordParameters(preparation.source, preparation.requestId, preparation.target), responseInstruction: preparation.responseInstruction,
      endpoint: "POST /api/agent/threads", request: agentReplyRequest(preparation)
    } : preparation.requestId ? {
      requestId: preparation.requestId,
      responseInstruction: preparation.responseInstruction,
      endpoint: "POST /api/agent/threads",
      request: agentReplyRequest(preparation),
      continuation: "需要继续往返时，将 request.responsePolicy 改为 required 并填写 responseInstruction。"
    } : {})
  };
}

export function renderAgentReplyParameters(preparation: AgentCommunicationPreparation): string {
  return `[回传参数]\n${JSON.stringify(agentReplyParameters(preparation), null, 2)}`;
}
