import { createHash } from "node:crypto";
import type { MessageContextRecord } from "./messageContextStore.js";

export function conversationScope(dataDir: string, gatewayId: string, adapter: string, identity: unknown) {
  const key = JSON.stringify({ dataDir, gatewayId, adapter, identity });
  return { key, scope: createHash("sha256").update(key).digest("hex").slice(0, 24) };
}

/** Share the exact cursor contract between AgentPacket and the send guard. */
export function conversationIndexForRecord(dataDir: string, record: MessageContextRecord): string | undefined {
  if (!record.sequence || !record.gatewayId) return undefined;
  const adapter = record.transport === "rabilink" ? "rabilink" : record.adapter;
  const group = record.kind === "group" || record.conversationKey?.includes(":group:") === true;
  const identity = adapter === "napcat"
    ? { target: group ? "group" : "private", groupId: group ? record.target : undefined,
      userId: group ? undefined : record.target, instanceId: record.instanceId || "" }
    : adapter === "rabilink" ? { deviceIds: record.sourceDeviceId ? [record.sourceDeviceId] : [], deviceKinds: [] }
    : { chatId: ["wecom", "feishu"].includes(adapter) ? record.target : undefined,
      sessionId: ["weixin", "speech", "fennenote"].includes(adapter) ? record.sessionId : undefined,
      roleId: adapter === "rolePanel" ? record.target || record.conversationKey?.split(":").at(-1) : undefined };
  const { scope } = conversationScope(dataDir, record.gatewayId, adapter, identity);
  return `c1.${scope}.${record.sequence}`;
}
