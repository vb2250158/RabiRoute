import type { ForwardRecord, ForwardRouteKind } from "./types.js";
import {
  messageContextFromHistoryRecord,
  type MessageContextHistoryKind,
  type MessageContextRecord
} from "../messageContextStore.js";
import {
  RECENT_MESSAGE_ENDPOINTS,
  type RecentMessageEndpoint
} from "../shared/gatewayConfigModel.js";

export type ForwardMessageContextScope = {
  record: MessageContextRecord;
  endpoint?: RecentMessageEndpoint;
};

export function messageContextHistoryKindForRouteKind(routeKind: ForwardRouteKind): MessageContextHistoryKind {
  if (routeKind === "private") return "private";
  if (["group_message", "direct_at", "direct_reply", "indirect_reply"].includes(routeKind)) return "group";
  if (routeKind === "wecom_message") return "wecom";
  if (routeKind === "heartbeat") return "heartbeat";
  if (routeKind === "manual_trigger") return "manual_trigger";
  if (routeKind === "role_panel_message") return "role_panel";
  return "voice";
}

export function logicalMessageAdapterForRecord(routeKind: ForwardRouteKind, record: ForwardRecord): string | undefined {
  if ("adapterType" in record && typeof record.adapterType === "string" && record.adapterType.trim()) return record.adapterType.trim();
  if (routeKind === "heartbeat") return "heartbeat";
  if (routeKind === "role_panel_message") return "rolePanel";
  if (routeKind === "wecom_message") return "wecom";
  if (["group_message", "direct_at", "direct_reply", "indirect_reply", "private"].includes(routeKind)) return "napcat";
  return undefined;
}

export function messageContextScopeForForward(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  values: { gatewayId?: string; routeProfileId?: string } = {}
): ForwardMessageContextScope | undefined {
  const rawRecord = {
    ...record,
    gatewayId: values.gatewayId,
    routeProfileId: "routeProfileId" in record && record.routeProfileId ? record.routeProfileId : values.routeProfileId
  };
  const contextRecord = messageContextFromHistoryRecord(
    messageContextHistoryKindForRouteKind(routeKind),
    rawRecord,
    logicalMessageAdapterForRecord(routeKind, record)
  );
  if (!contextRecord) return undefined;
  const endpoint = RECENT_MESSAGE_ENDPOINTS.includes(contextRecord.adapter as RecentMessageEndpoint)
    ? contextRecord.adapter as RecentMessageEndpoint
    : undefined;
  return { record: contextRecord, endpoint };
}
