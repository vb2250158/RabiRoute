import { conversationMessageWindow, type MessageContextRecord } from "./messageContextStore.js";

export type ConversationWindowFilter = { gatewayId: string; channel: string; adapter: string; target: Record<string, unknown>; instanceId: string; beforeSequence?: number; query?: string };
export type ConversationWindow = ReturnType<typeof conversationMessageWindow>;
export type ConversationWindowReader = (dataDir: string, filter: ConversationWindowFilter, options: { afterSequence?: number; limit: number }) => Promise<ConversationWindow>;

export function matchesConversationWindow(filter: ConversationWindowFilter, record: MessageContextRecord): boolean {
  const { target, adapter, instanceId } = filter;
  if (filter.beforeSequence !== undefined && record.sequence! > filter.beforeSequence) return false;
  const terms = filter.query?.split(/[\s,，、]+/).filter(Boolean).map(term => term.toLocaleLowerCase()) ?? [];
  if (terms.length && !terms.some(term => `${record.text} ${record.sender ?? ""}`.toLocaleLowerCase().includes(term))) return false;

      if (record.gatewayId && record.gatewayId !== filter.gatewayId) return false;
      if (filter.channel === "rabilink") {
        return record.transport === "rabilink" && ((target.targetDeviceIds as string[]).includes(record.sourceDeviceId || "")
          || (target.targetDeviceKinds as string[]).includes(record.sourceDeviceKind || "")
          || record.targetDeviceIds?.some(id => (target.targetDeviceIds as string[]).includes(id)) === true
          || record.targetDeviceKinds?.some(kind => (target.targetDeviceKinds as string[]).includes(kind)) === true);
      }
      if (record.adapter !== adapter) return false;
      if (instanceId && record.instanceId && record.instanceId !== instanceId) return false;
      if (filter.channel === "napcat") return record.target === String(target.groupId || target.userId)
        && (target.target === "group" ? record.kind === "group" || record.conversationKey?.includes(":group:") === true
          : record.kind === "private" || record.conversationKey?.includes(":private:") === true);
      if (target.chatId) return record.target === String(target.chatId);
      if (target.sessionId) return record.sessionId === String(target.sessionId);
      if (target.roleId) return record.target === String(target.roleId) || record.conversationKey?.endsWith(`:${target.roleId}`) === true;
      return true;


}

export function readConversationWindow(dataDir: string, filter: ConversationWindowFilter, options: { afterSequence?: number; limit: number }): ConversationWindow {
  return conversationMessageWindow(dataDir, { ...options, matches: record => matchesConversationWindow(filter, record) });
}
