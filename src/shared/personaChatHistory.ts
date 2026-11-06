/** Display identity only; never includes endpoint credentials or authorization incarnations. */
export type PersonaChatTaskOwner = {
  kind: "local" | "instance" | "device" | "service";
  provider: string;
  agentId: string;
  nodeId?: string;
  nodeName?: string;
};

/** Display-only projection; never copy credentials or authorization incarnations from an execution endpoint. */
export function chatTaskOwner(
  party: { endpoint?: Pick<PersonaChatTaskOwner, "kind" | "provider" | "agentId"> & { nodeId?: string; instanceId?: string } } | undefined,
  nodeName?: (nodeId: string) => string | undefined
): PersonaChatTaskOwner | undefined {
  const endpoint = party?.endpoint;
  if (!endpoint) return undefined;
  const nodeId = endpoint.nodeId || endpoint.instanceId;
  return { kind: endpoint.kind, provider: endpoint.provider, agentId: endpoint.agentId,
    ...(nodeId ? { nodeId, nodeName: nodeName?.(nodeId) } : {}) };
}

/** Persona messages: Hook final replies and managed Agent-to-Agent deliveries. */
export type PersonaChatReply = {
  id: string;
  historyCursor?: number;
  historyEndCursor?: number;
  textTruncated?: boolean;
  receivedAt: string;
  sessionId: string;
  turnId?: string;
  kind?: "final_reply" | "agent_delivery" | "user_delivery" | "aiui_user" | "aiui_assistant";
  deliveryId?: string;
  sourceLabel?: string;
  planId?: string;
  planTitle?: string;
  feedbackId?: string;
  deliveryStatus?: "delivered" | "unconfirmed";
  targetSessionId?: string;
  targetSessionTitle?: string;
  targetTaskUrl?: string;
  sourceTaskOwner?: PersonaChatTaskOwner;
  targetTaskOwner?: PersonaChatTaskOwner;
  sourceTaskKey?: string;
  targetTaskKey?: string;
  text: string;
  /** Recorded name, refreshed from the matching task owner when available. */
  sessionTitle?: string;
  taskUrl?: string;
};

export type PersonaChatHistoryPage = {
  entries: PersonaChatReply[];
  /** Exclusive byte offset in the append-only history; null means the beginning. */
  nextCursor: number | null;
  newerCursor?: number | null;
  invalidRecords?: number;
};

export type PersonaHistoryTask = {
  key: string; sessionId: string; title: string; owner?: PersonaChatTaskOwner; taskUrl?: string;
  receivedAt: string; preview: string;
};
export type PersonaHistoryTaskPage = { items: PersonaHistoryTask[]; nextCursor: string | null; invalidRecords: number };

/** A task belongs to its recorded host, even when another host uses the same thread ID. */
export function personaHistoryTaskKey(sessionId: string, owner?: PersonaChatTaskOwner): string {
  const kind = owner?.kind ?? 'local';
  const provider = !owner || ['codex', 'codex-desktop'].includes(owner.provider) ? 'codex' : owner.provider;
  return JSON.stringify([kind, provider, owner?.nodeId ?? '', kind === 'local' ? '' : owner?.agentId ?? '', sessionId]);
}
export function personaHistoryTaskReferences(record: PersonaChatReply): PersonaHistoryTask[] {
  const tasks: PersonaHistoryTask[] = [];
  if (record.kind !== 'user_delivery' && !record.kind?.startsWith('aiui_')) tasks.push({
    key: personaHistoryTaskKey(record.sessionId, record.sourceTaskOwner), sessionId: record.sessionId,
    title: record.sessionTitle || record.sessionId, owner: record.sourceTaskOwner, taskUrl: record.taskUrl,
    receivedAt: record.receivedAt, preview: record.text.slice(0, 120)
  });
  if (record.targetSessionId) tasks.push({
    key: personaHistoryTaskKey(record.targetSessionId, record.targetTaskOwner), sessionId: record.targetSessionId,
    title: record.targetSessionTitle || record.targetSessionId, owner: record.targetTaskOwner, taskUrl: record.targetTaskUrl,
    receivedAt: record.receivedAt, preview: record.text.slice(0, 120)
  });
  return [...new Map(tasks.map(task => [task.key, task])).values()];
}
