import path from "node:path";
import { createAgentAdapter } from "./agentAdapters/agentAdapter.js";
import type { AgentAdapterType } from "./agentAdapters/types.js";
import { config, rolePathsForRoute, type RouteProfile } from "./config.js";
import {
  appendCodexNotificationToDir,
  appendGroupMessageToDir,
  appendHeartbeatEventToDir,
  appendManualTriggerEventToDir,
  appendPrivateMessageToDir,
  appendVoiceTranscriptEventToDir
} from "./history.js";
import { buildAgentPacket } from "./routing/agentPacket.js";
import {
  createRouteDecision,
  isGroupRecord,
  isHeartbeatRecord,
  isManualTriggerRecord,
  isVoiceTranscriptRecord
} from "./routing/routeDecision.js";
import type {
  ForwardLogKind,
  ForwardRecord,
  ForwardRouteKind,
  ForwardTemplateValues
} from "./routing/types.js";

export type {
  ForwardRouteKind,
  ForwardTemplateValues
} from "./routing/types.js";

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
  return routeKind === "private" ? "private" : "group_mention";
}

function dispatchToAgentAdapter(type: AgentAdapterType, message: string): Promise<void> {
  const adapter = createAgentAdapter(type);
  return adapter.deliver(message);
}

function activeRouteProfiles(): RouteProfile[] {
  return config.routeProfiles.filter((route) => route.enabled !== false);
}

function appendRecordToRoleDataDir(record: ForwardRecord, dataDir: string): void {
  if (isGroupRecord(record)) {
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
  extraValues: ForwardTemplateValues = {}
): Promise<void> {
  if (routeKind === "voice_transcript" && isLowSignalVoiceTranscript(record)) {
    return;
  }

  const decision = createRouteDecision(route, routeKind, record, extraValues);
  if (!decision) {
    return;
  }

  const roleContext = rolePathsForRoute(route);
  if (path.resolve(roleContext.dataDir) !== path.resolve(config.memoryDataDir)) {
    appendRecordToRoleDataDir(record, roleContext.dataDir);
  }

  for (const rule of decision.matchedRules) {
    const packet = buildAgentPacket(decision, rule, roleContext);

    appendCodexNotificationToDir({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      time: Math.floor(Date.now() / 1000),
      kind: logKindForRoute(routeKind),
      text: packet.message
    }, roleContext.dataDir);

    await Promise.all(configuredAgentAdapters().map((adapter) => dispatchToAgentAdapter(adapter, packet.message)));
  }
}

export async function forwardMessageAndWait(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues = {}
): Promise<void> {
  for (const route of activeRouteProfiles()) {
    await forwardMessageToRoute(route, routeKind, record, extraValues);
  }
}

export function forwardMessage(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues = {}
): void {
  void forwardMessageAndWait(routeKind, record, extraValues)
    .catch((error) => console.error("Failed to deliver routed message", error));
}
