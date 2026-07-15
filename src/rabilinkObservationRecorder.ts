import { createHash } from "node:crypto";
import { config } from "./config.js";
import type { VoiceTranscriptEventRecord } from "./history.js";
import {
  appendRabiLinkConversationEntry,
  DEFAULT_RABILINK_CONVERSATION_SPLIT_AFTER_MS,
  type AppendRabiLinkConversationResult
} from "./rabilinkConversationLedger.js";
import { startDefaultRabiLinkConversationReviewer } from "./rabilinkConversationReviewer.js";

export type RabiLinkObservationRecordOptions = {
  dataDir?: string;
  routeVariables?: Record<string, string>;
  wakeReviewer?: boolean;
};

function recordFirstSources(value: unknown): Set<string> {
  const text = String(value ?? "").trim();
  if (!text) return new Set();

  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        return new Set(parsed.map((item) => String(item).trim().toLowerCase()).filter(Boolean));
      }
    } catch {
      // Fall through to the forgiving comma/space parser used by the route editor.
    }
  }

  return new Set(text.split(/[\s,;]+/).map((item) => item.trim().toLowerCase()).filter(Boolean));
}

export function isRabiLinkRecordFirstSource(
  adapterType: string | undefined,
  source: string | undefined,
  routeVariables: Record<string, string> = config.routeVariables
): boolean {
  const configured = recordFirstSources(routeVariables.rabilinkRecordFirstSources);
  if (configured.has("*")) return true;
  return [adapterType, source]
    .map((item) => String(item ?? "").trim().toLowerCase())
    .some((item) => Boolean(item) && configured.has(item));
}

function splitAfterMs(routeVariables: Record<string, string>): number {
  const hours = Number(routeVariables.rabilinkConversationSplitAfterHours);
  return Number.isFinite(hours) && hours > 0
    ? Math.max(60 * 1000, hours * 60 * 60 * 1000)
    : DEFAULT_RABILINK_CONVERSATION_SPLIT_AFTER_MS;
}

function validDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function recordedAt(record: VoiceTranscriptEventRecord): string {
  const explicit = validDate(record.endedAt) || validDate(record.startedAt);
  if (explicit) return explicit;
  const timestamp = Number(record.time) * 1000;
  const date = new Date(timestamp);
  return Number.isFinite(timestamp) && Number.isFinite(date.getTime())
    ? date.toISOString()
    : new Date().toISOString();
}

function capturedAt(record: VoiceTranscriptEventRecord): number | undefined {
  const timestamp = Date.parse(record.startedAt || "");
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function observationEntryId(record: VoiceTranscriptEventRecord): string {
  const adapterType = String(record.adapterType || "voice_transcript").trim().toLowerCase() || "voice_transcript";
  const identity = [
    adapterType,
    record.source || "",
    record.sourceDeviceId || "",
    record.sourceDeviceKind || "",
    record.transport || "",
    record.sessionId || "",
    record.messageId == null ? "" : String(record.messageId),
    record.messageId == null ? String(record.time) : "",
    record.messageId == null ? record.rawMessage : ""
  ].join("\u0000");
  const digest = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 24);
  return `rabilink-user:${adapterType}:${digest}`;
}

export function recordRabiLinkVoiceObservation(
  record: VoiceTranscriptEventRecord,
  options: RabiLinkObservationRecordOptions = {}
): AppendRabiLinkConversationResult {
  const routeVariables = options.routeVariables ?? config.routeVariables;
  const result = appendRabiLinkConversationEntry(options.dataDir ?? config.memoryDataDir, {
    entryId: observationEntryId(record),
    recordedAt: recordedAt(record),
    time: record.time,
    direction: "user_to_agent",
    kind: "voice_transcript",
    text: record.rawMessage,
    source: record.source || record.adapterType || "voice_transcript",
    sender: record.speakerName || record.senderName,
    messageId: record.messageId == null ? undefined : String(record.messageId),
    sessionId: record.sessionId,
    sourceDeviceId: record.sourceDeviceId,
    sourceDeviceName: record.sourceDeviceName,
    sourceDeviceKind: record.sourceDeviceKind,
    transport: record.transport,
    capturedAt: capturedAt(record),
    requiresReview: true
  }, { splitAfterMs: splitAfterMs(routeVariables) });

  if (result.appended && options.wakeReviewer !== false) {
    startDefaultRabiLinkConversationReviewer()?.wake();
  }
  return result;
}
