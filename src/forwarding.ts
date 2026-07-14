import path from "node:path";
import { createAgentAdapter } from "./agentAdapters/agentAdapter.js";
import type { AgentAdapterType } from "./agentAdapters/types.js";
import { isCodexMonitorThreadActive } from "./codexDesktopIpc.js";
import { config, rolePathsForRoute, type RouteProfile } from "./config.js";
import {
  appendCodexNotificationToDir,
  appendAdapterLogToDir,
  appendGroupMessageToDir,
  appendHeartbeatEventToDir,
  appendManualTriggerEventToDir,
  appendPrivateMessageToDir,
  appendVoiceTranscriptEventToDir,
  appendWeComMessageToDir
} from "./history.js";
import { buildAgentPacket } from "./routing/agentPacket.js";
import {
  createRouteDecision,
  isGroupRecord,
  isHeartbeatRecord,
  isManualTriggerRecord,
  isWeComRecord,
  isVoiceTranscriptRecord
} from "./routing/routeDecision.js";
import type {
  ForwardLogKind,
  ForwardRecord,
  ForwardRouteKind,
  ForwardTemplateValues
} from "./routing/types.js";
import {
  appendDeliveryReplayAttempt,
  createDeliveryReplayAttemptId,
  type DeliveryReplayPacket
} from "./deliveryReplayLedger.js";

export type {
  ForwardRouteKind,
  ForwardTemplateValues
} from "./routing/types.js";

export type ForwardDeliveryStatus = "delivered" | "routed" | "missed" | "failed" | "skipped";
export type ForwardDeliveryReason = "no_active_route_profile" | "no_matching_rule" | "low_signal_voice_transcript" | "no_agent_adapter" | "agent_busy";

export type ForwardAdapterOutcome = {
  routeId: string;
  ruleId: string;
  adapter: AgentAdapterType;
  status: "delivered" | "failed";
  error?: string;
};

export type ForwardRouteDeliveryResult = {
  routeId: string;
  routeName: string;
  status: ForwardDeliveryStatus;
  matchedRuleIds: string[];
  matchedRuleCount: number;
  sentPacketCount: number;
  adapterOutcomes: ForwardAdapterOutcome[];
  reason?: ForwardDeliveryReason;
};

export type ForwardDeliveryResult = {
  routeKind: ForwardRouteKind;
  messageId: string;
  status: ForwardDeliveryStatus;
  matchedRuleIds: string[];
  matchedRuleCount: number;
  sentPacketCount: number;
  adapterOutcomes: ForwardAdapterOutcome[];
  routes: ForwardRouteDeliveryResult[];
  reason?: ForwardDeliveryReason;
};

export type ForwardMessageOptions = {
  appendRoleRecord?: boolean;
  logReplayAttempt?: boolean;
  replayOfAttemptId?: string;
};

function logDeliveryResult(result: ForwardDeliveryResult): void {
  const failed = result.status === "failed";
  const missed = result.status === "missed" || result.status === "skipped";
  appendAdapterLogToDir("router", {
    event: "delivery_result",
    level: failed ? "error" : missed ? "warning" : "info",
    message: `Delivery ${result.status} routeKind=${result.routeKind} messageId=${result.messageId} matched=${result.matchedRuleCount} sent=${result.sentPacketCount}`,
    data: result
  }, config.dataDir);
}

function configuredAgentAdapters(): AgentAdapterType[] {
  if (config.agentAdapters.length > 0) {
    return config.agentAdapters;
  }
  if (config.codexDesktopIpcNotify) {
    return ["codex"];
  }
  if (config.codexDirectNotify) {
    return ["codex"];
  }
  if (process.env.ASTRBOT_URL) {
    return ["astrbot"];
  }
  return [];
}

export function shouldSkipHeartbeatDelivery(
  routeKind: ForwardRouteKind,
  skipWhenAgentBusy: boolean,
  agentAdapters: AgentAdapterType[],
  codexThreadActive: boolean
): boolean {
  return routeKind === "heartbeat"
    && skipWhenAgentBusy
    && agentAdapters.includes("codex")
    && codexThreadActive;
}

function heartbeatShouldSkipForBusyAgent(routeKind: ForwardRouteKind): boolean {
  return shouldSkipHeartbeatDelivery(
    routeKind,
    config.heartbeatSkipWhenAgentBusy,
    configuredAgentAdapters(),
    isCodexMonitorThreadActive()
  );
}

function logKindForRoute(routeKind: ForwardRouteKind): ForwardLogKind {
  if (routeKind === "heartbeat") {
    return "heartbeat";
  }
  if (routeKind === "manual_trigger") {
    return "manual_trigger";
  }
  if (routeKind === "role_panel_message") {
    return "role_panel_message";
  }
  if (routeKind === "voice_transcript") {
    return "voice_transcript";
  }
  if (routeKind === "rabilink") {
    return "rabilink";
  }
  if (routeKind === "wecom_message") {
    return "wecom_message";
  }
  return routeKind === "private" ? "private" : "group_mention";
}

function dispatchToAgentAdapter(type: AgentAdapterType, message: string): Promise<void> {
  const adapter = createAgentAdapter(type);
  return adapter.deliver(message);
}

export async function deliverPacketToAgentAdapters(routeId: string, ruleId: string, message: string): Promise<ForwardAdapterOutcome[]> {
  return Promise.all(configuredAgentAdapters().map(async (adapter) => {
    try {
      await dispatchToAgentAdapter(adapter, message);
      return {
        routeId,
        ruleId,
        adapter,
        status: "delivered" as const
      };
    } catch (error) {
      return {
        routeId,
        ruleId,
        adapter,
        status: "failed" as const,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }));
}

function activeRouteProfiles(): RouteProfile[] {
  return config.routeProfiles.filter((route) => route.enabled !== false);
}

function recordId(record: ForwardRecord): string {
  return String(record.messageId ?? record.time ?? "unknown");
}

function previewMessage(record: ForwardRecord): string {
  return record.rawMessage.replace(/\s+/g, " ").trim().slice(0, 120);
}

function logRouteMiss(routeKind: ForwardRouteKind, record: ForwardRecord, reason: string, route?: RouteProfile): void {
  const message = route
    ? `No route rule matched routeKind=${routeKind} route=${route.id} rules=${route.notificationRules.length} messageId=${recordId(record)} message="${previewMessage(record)}"`
    : `No active route profile for routeKind=${routeKind} messageId=${recordId(record)} message="${previewMessage(record)}"`;
  appendAdapterLogToDir("router", {
    event: "route_miss",
    level: "warning",
    message,
    data: {
      reason,
      routeKind,
      routeId: route?.id,
      routeName: route?.name,
      ruleCount: route?.notificationRules.length ?? 0,
      messageId: record.messageId,
      preview: previewMessage(record)
    }
  }, config.dataDir);
  console.warn(message);
}

function routeResult(
  route: RouteProfile,
  status: ForwardDeliveryStatus,
  patch: Partial<Omit<ForwardRouteDeliveryResult, "routeId" | "routeName" | "status">> = {}
): ForwardRouteDeliveryResult {
  const matchedRuleIds = patch.matchedRuleIds ?? [];
  const adapterOutcomes = patch.adapterOutcomes ?? [];
  return {
    routeId: route.id,
    routeName: route.name,
    status,
    matchedRuleIds,
    matchedRuleCount: patch.matchedRuleCount ?? matchedRuleIds.length,
    sentPacketCount: patch.sentPacketCount ?? 0,
    adapterOutcomes,
    reason: patch.reason
  };
}

function summarizeDeliveryResult(routeKind: ForwardRouteKind, record: ForwardRecord, routes: ForwardRouteDeliveryResult[], fallbackReason?: ForwardDeliveryReason): ForwardDeliveryResult {
  const adapterOutcomes = routes.flatMap((route) => route.adapterOutcomes);
  const matchedRuleIds = routes.flatMap((route) => route.matchedRuleIds);
  const sentPacketCount = routes.reduce((sum, route) => sum + route.sentPacketCount, 0);
  const matchedRuleCount = routes.reduce((sum, route) => sum + route.matchedRuleCount, 0);
  const failed = adapterOutcomes.some((outcome) => outcome.status === "failed");
  const delivered = adapterOutcomes.some((outcome) => outcome.status === "delivered");
  const routed = routes.some((route) => route.status === "routed" || route.status === "delivered" || route.status === "failed");
  const skipped = routes.length > 0 && routes.every((route) => route.status === "skipped");
  const missed = routes.length === 0 || routes.every((route) => route.status === "missed" || route.status === "skipped");
  const status: ForwardDeliveryStatus = failed
    ? "failed"
    : delivered
      ? "delivered"
      : routed
        ? "routed"
        : skipped
          ? "skipped"
          : missed
            ? "missed"
            : "routed";
  const reasons = [...new Set(routes.map((route) => route.reason).filter((reason): reason is ForwardDeliveryReason => Boolean(reason)))];
  const reason = fallbackReason ?? (reasons.length === 1 ? reasons[0] : undefined);

  return {
    routeKind,
    messageId: recordId(record),
    status,
    matchedRuleIds,
    matchedRuleCount,
    sentPacketCount,
    adapterOutcomes,
    routes,
    reason
  };
}

function appendRecordToRoleDataDir(record: ForwardRecord, dataDir: string): void {
  if (isWeComRecord(record)) {
    appendWeComMessageToDir(record, dataDir);
  } else if (isGroupRecord(record)) {
    appendGroupMessageToDir(record, dataDir);
  } else if (isHeartbeatRecord(record)) {
    appendHeartbeatEventToDir(record, dataDir);
  } else if (isManualTriggerRecord(record)) {
    appendManualTriggerEventToDir(record, dataDir);
  } else if (isVoiceTranscriptRecord(record)) {
    appendVoiceTranscriptEventToDir(record, dataDir);
  } else {
    appendPrivateMessageToDir(record, dataDir);
  }
}

function isLowSignalVoiceTranscript(record: ForwardRecord): boolean {
  if (!isVoiceTranscriptRecord(record)) {
    return false;
  }

  const text = record.rawMessage
    .replace(/[\s，。！？!?、,.~…]+/g, "")
    .trim();
  if (!text) {
    return true;
  }

  const fillerOnly = /^(嗯+|呃+|啊+|唔+|哦+|咳+|咳咳|哼+)$/.test(text);
  if (!fillerOnly) {
    return false;
  }

  const speakerName = record.speakerName ?? "";
  const likelyUnstableSpeaker = record.speakerDecision === "auto_enrolled"
    || record.speakerKind === "unknown"
    || speakerName.startsWith("unknown_");
  return likelyUnstableSpeaker || text.length <= 2;
}

async function forwardMessageToRoute(
  route: RouteProfile,
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues = {},
  options: ForwardMessageOptions = {},
  packets: DeliveryReplayPacket[] = []
): Promise<ForwardRouteDeliveryResult> {
  if (routeKind === "voice_transcript" && isLowSignalVoiceTranscript(record)) {
    return routeResult(route, "skipped", { reason: "low_signal_voice_transcript" });
  }

  const decision = createRouteDecision(route, routeKind, record, extraValues);
  if (!decision) {
    logRouteMiss(routeKind, record, "no_matching_rule", route);
    return routeResult(route, "missed", { reason: "no_matching_rule" });
  }

  if (heartbeatShouldSkipForBusyAgent(routeKind)) {
    appendAdapterLogToDir("router", {
      event: "heartbeat_skipped_agent_busy",
      level: "info",
      message: `Heartbeat skipped because the Codex thread is active route=${route.id} messageId=${recordId(record)}`,
      data: {
        routeKind,
        routeId: route.id,
        routeName: route.name,
        messageId: recordId(record),
        reason: "agent_busy"
      }
    }, config.dataDir);
    return routeResult(route, "skipped", { reason: "agent_busy" });
  }

  const roleContext = rolePathsForRoute(route);
  if (options.appendRoleRecord !== false && path.resolve(roleContext.dataDir) !== path.resolve(config.memoryDataDir)) {
    appendRecordToRoleDataDir(record, roleContext.dataDir);
  }

  const adapterOutcomes: ForwardAdapterOutcome[] = [];
  let sentPacketCount = 0;
  for (const rule of decision.matchedRules) {
    const packet = buildAgentPacket(decision, rule, roleContext);
    packets.push({
      routeId: route.id,
      ruleId: rule.id,
      message: packet.message
    });

    appendCodexNotificationToDir({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      time: Math.floor(Date.now() / 1000),
      kind: logKindForRoute(routeKind),
      text: packet.message
    }, roleContext.dataDir);

    sentPacketCount += 1;
    adapterOutcomes.push(...await deliverPacketToAgentAdapters(route.id, rule.id, packet.message));
  }

  const failed = adapterOutcomes.some((outcome) => outcome.status === "failed");
  const delivered = adapterOutcomes.some((outcome) => outcome.status === "delivered");
  return routeResult(route, failed ? "failed" : delivered ? "delivered" : "routed", {
    matchedRuleIds: decision.matchedRules.map((rule) => rule.id),
    sentPacketCount,
    adapterOutcomes,
    reason: adapterOutcomes.length === 0 ? "no_agent_adapter" : undefined
  });
}

export async function forwardMessageAndWait(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues = {},
  options: ForwardMessageOptions = {}
): Promise<ForwardDeliveryResult> {
  const routes = activeRouteProfiles();
  const packets: DeliveryReplayPacket[] = [];
  if (routes.length === 0) {
    logRouteMiss(routeKind, record, "no_active_route_profile");
    const result = summarizeDeliveryResult(routeKind, record, [], "no_active_route_profile");
    logDeliveryResult(result);
    if (options.logReplayAttempt !== false) {
      logDeliveryReplayAttempt(routeKind, record, extraValues, result, packets, options);
    }
    return result;
  }
  const results: ForwardRouteDeliveryResult[] = [];
  for (const route of routes) {
    results.push(await forwardMessageToRoute(route, routeKind, record, extraValues, options, packets));
  }
  const result = summarizeDeliveryResult(routeKind, record, results);
  logDeliveryResult(result);
  if (options.logReplayAttempt !== false) {
    logDeliveryReplayAttempt(routeKind, record, extraValues, result, packets, options);
  }
  return result;
}

function logDeliveryReplayAttempt(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues,
  result: ForwardDeliveryResult,
  packets: DeliveryReplayPacket[],
  options: ForwardMessageOptions
): void {
  appendDeliveryReplayAttempt(config.dataDir, {
    attemptId: createDeliveryReplayAttemptId(routeKind, result.messageId),
    time: Math.floor(Date.now() / 1000),
    routeKind,
    messageId: result.messageId,
    record,
    extraValues,
    packets,
    result,
    replayOfAttemptId: options.replayOfAttemptId
  });
}

export function forwardMessage(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues = {}
): void {
  void forwardMessageAndWait(routeKind, record, extraValues)
    .catch((error) => {
      appendAdapterLogToDir("router", {
        event: "delivery_error",
        level: "error",
        message: `Failed to deliver routed message routeKind=${routeKind} messageId=${recordId(record)}`,
        data: {
          routeKind,
          messageId: recordId(record),
          error: error instanceof Error ? error.message : String(error)
        }
      }, config.dataDir);
      console.error("Failed to deliver routed message", error);
    });
}
