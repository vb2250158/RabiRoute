import type { AgentSessionDestination } from "@shared/agentDeliveryTarget";

export type SessionTarget = AgentSessionDestination;
export type DeliverySession = {
  id: string; name?: string; projectPath?: string; cwd?: string; title?: string;
  kind?: string | number; memberAgentIds?: string[]; nativeAgentId?: string; nativeAgentName?: string;
};

export function isGroupSession(row: DeliverySession): boolean {
  return row.kind === "ROOM" || row.kind === "GROK_BOT_AGENT_KIND_ROOM" || row.kind === 2 || row.kind === "2";
}

export function deliverySessions(rows: readonly DeliverySession[], target: SessionTarget): DeliverySession[] {
  if (target.agentAdapter !== "grokBot") return [...rows];
  return rows.filter(row => target.deliveryType === "group" ? isGroupSession(row) : !isGroupSession(row));
}

export function senderIdentities(rows: readonly DeliverySession[], room?: DeliverySession, group = true): DeliverySession[] {
  const members = new Set(room?.memberAgentIds ?? []);
  return [...new Map(rows.filter(row => !isGroupSession(row) && row.nativeAgentId && (!group || members.has(row.nativeAgentId)))
    .map(row => [row.nativeAgentId!, row])).values()];
}

export function changeDeliveryType(target: SessionTarget, deliveryType: "private" | "group"): SessionTarget {
  const { senderAgentId, senderAgentName, ...rest } = target;
  return { ...rest, deliveryType, sendMode: "direct", sessionId: "", sessionName: "", workspace: "" };
}

export function changeSendMode(target: SessionTarget, sendMode: "direct" | "identity"): SessionTarget {
  const { senderAgentId, senderAgentName, ...rest } = target;
  return { ...rest, ...(target.agentAdapter === "grokBot" ? { deliveryType: target.deliveryType ?? "private" } : {}), sendMode };
}

export function chooseDeliverySession(target: SessionTarget, row: DeliverySession): SessionTarget | undefined {
  if (!deliverySessions([row], target).length) return undefined;
  const { senderAgentId, senderAgentName, ...rest } = target;
  return { ...rest, ...(target.agentAdapter === "grokBot" ? { deliveryType: target.deliveryType ?? "private", sendMode: target.sendMode ?? "direct" } : {}),
    sessionId: row.id, sessionName: row.name || row.title || row.id, workspace: row.projectPath || row.cwd || "" };
}

export function chooseSenderIdentity(target: SessionTarget, rows: readonly DeliverySession[], room: DeliverySession | undefined, nativeAgentId: string): SessionTarget | undefined {
  if (target.sendMode !== "identity") return undefined;
  const sender = senderIdentities(rows, room, target.deliveryType === "group").find(row => row.nativeAgentId === nativeAgentId);
  return sender ? { ...target, senderAgentId: nativeAgentId, senderAgentName: sender.nativeAgentName || sender.name || sender.title || nativeAgentId } : undefined;
}
