import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  SpeechIngressRecord,
  SpeechMessageCommand,
  SpeechMessageStatus,
  SpeechTranscriptSegment
} from "./shared/speechControlContract.js";
import { normalizeSpeechTranscriptSegment } from "./shared/speechTranscript.js";
import { withFileLockSync } from "./shared/filePersistence.js";

const MAX_TEXT_LENGTH = 100_000;
const MAX_SEGMENTS = 10_000;

export type SpeechIngressAppendResult = {
  record: SpeechIngressRecord;
  appended: boolean;
};

export type SpeechRouteDeliveryReceipt = {
  schemaVersion: 1;
  recordId: string;
  routeId: string;
  messageAdapterType: "speech" | "rabilink";
  status: Extract<SpeechMessageStatus, "delivered" | "recorded">;
  reason?: string;
  detail?: string;
  completedAt: string;
};

function oneLine(value: unknown, maxLength = 200): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function optionalNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function timestamp(value: unknown, fallback = Date.now() / 1_000): number {
  if (typeof value === "string" && value.trim() && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed / 1_000;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed > 10_000_000_000 ? parsed / 1_000 : parsed;
}

function optionalTimestamp(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "string" && value.trim() && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed / 1_000 : undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed > 10_000_000_000 ? parsed / 1_000 : parsed;
}

export function normalizeSpeechIngressRecord(
  command: SpeechMessageCommand,
  fallbackId = `speech-${randomUUID()}`
): SpeechIngressRecord {
  const text = String(command.text ?? "").trim().slice(0, MAX_TEXT_LENGTH);
  if (!text) throw new Error("Speech ingress text is required.");
  const time = timestamp(command.startedAt ?? command.recordedAt);
  const ingestedTime = timestamp(command.ingestedAt, Date.now() / 1_000);
  const duration = optionalNumber(command.duration);
  const completedTime = optionalTimestamp(command.completedAt)
    ?? (duration == null ? undefined : time + Math.max(0, duration));
  const id = oneLine(command.recordId, 200) || fallbackId;
  const sessionId = oneLine(command.sessionId, 200) || `speech-${new Date(time * 1_000).toISOString().slice(0, 10)}`;
  const requestedAdapterType = oneLine(command.messageAdapterType, 20).toLowerCase();
  const messageAdapterType = requestedAdapterType === "rabilink" ? "rabilink" : "speech";
  const defaultSource = messageAdapterType === "rabilink" ? "mobile_audio_stream" : "pc_microphone";
  const defaultTransport = messageAdapterType === "rabilink" ? "rabispeech_remote_audio" : "rabispeech_local_audio";
  const defaultChannelType = messageAdapterType === "rabilink" ? "rabilink.mobile_audio" : "speech.pc_microphone";
  const segments = (Array.isArray(command.segments) ? command.segments : [])
    .slice(0, MAX_SEGMENTS)
    .map((segment, index) => normalizeSpeechTranscriptSegment(segment, index))
    .filter((item): item is SpeechTranscriptSegment => Boolean(item));
  return {
    schemaVersion: 1,
    id,
    recordedAt: new Date(time * 1_000).toISOString(),
    ingestedAt: new Date(ingestedTime * 1_000).toISOString(),
    time,
    source: oneLine(command.source) || defaultSource,
    transport: oneLine(command.transport) || defaultTransport,
    channelType: oneLine(command.channelType) || defaultChannelType,
    messageAdapterType,
    sourceDeviceId: oneLine(command.sourceDeviceId) || undefined,
    sourceDeviceName: oneLine(command.sourceDeviceName) || undefined,
    sourceDeviceKind: oneLine(command.sourceDeviceKind) || undefined,
    sourceStreamId: oneLine(command.sourceStreamId) || undefined,
    sourceHostId: oneLine(command.sourceHostId) || undefined,
    sourceHostName: oneLine(command.sourceHostName) || undefined,
    sampleRate: optionalNumber(command.sampleRate),
    audioFormat: oneLine(command.audioFormat, 100) || undefined,
    channels: command.channels == null ? undefined : Math.max(1, Math.min(64, Math.floor(optionalNumber(command.channels) ?? 1))),
    peak: optionalNumber(command.peak),
    rms: optionalNumber(command.rms),
    sessionId,
    routeProfileId: oneLine(command.routeProfileId) || undefined,
    text,
    provider: oneLine(command.provider) || undefined,
    model: oneLine(command.model) || undefined,
    language: oneLine(command.language, 40) || undefined,
    duration,
    startedAt: new Date(time * 1_000).toISOString(),
    completedAt: completedTime == null ? undefined : new Date(Math.max(time, completedTime) * 1_000).toISOString(),
    segments
  };
}

function parseJsonl(filePath: string): SpeechIngressRecord[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return [];
    try {
      const parsed = JSON.parse(line) as SpeechIngressRecord;
      return parsed?.schemaVersion === 1 && parsed.id
        ? [normalizeSpeechIngressRecord(parsed, parsed.id)]
        : [];
    } catch {
      return [];
    }
  });
}

export class SpeechIngressStore {
  readonly deliveryRoot: string;

  constructor(readonly root: string, deliveryRoot = path.join(root, ".deliveries")) {
    this.deliveryRoot = deliveryRoot;
  }

  append(command: SpeechMessageCommand, fallbackId?: string): SpeechIngressAppendResult {
    const record = normalizeSpeechIngressRecord(command, fallbackId);
    return withFileLockSync(path.join(this.root, ".speech-ingress.lock"), () => {
      const existing = this.read(record.id);
      if (existing) return { record: existing, appended: false };
      fs.mkdirSync(this.root, { recursive: true });
      const filePath = path.join(this.root, `${record.recordedAt.slice(0, 10)}.jsonl`);
      fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
      return { record, appended: true };
    });
  }

  read(recordId: string): SpeechIngressRecord | undefined {
    const normalizedId = oneLine(recordId, 200);
    if (!normalizedId || !fs.existsSync(this.root)) return undefined;
    const files = fs.readdirSync(this.root, { withFileTypes: true })
      .filter(item => item.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(item.name))
      .map(item => path.join(this.root, item.name))
      .sort((left, right) => right.localeCompare(left));
    for (const filePath of files) {
      const match = parseJsonl(filePath).find(item => item.id === normalizedId);
      if (match) return match;
    }
    return undefined;
  }

  list(limit = 200): SpeechIngressRecord[] {
    if (!fs.existsSync(this.root)) return [];
    const maximum = Math.max(1, Math.min(1_000, Math.floor(limit)));
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter(item => item.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(item.name))
      .map(item => path.join(this.root, item.name))
      .sort((left, right) => right.localeCompare(left))
      .flatMap(filePath => parseJsonl(filePath).reverse())
      .slice(0, maximum);
  }

  readDeliveryReceipt(recordId: string, routeId: string): SpeechRouteDeliveryReceipt | undefined {
    const normalizedRecordId = oneLine(recordId, 200);
    const normalizedRouteId = oneLine(routeId, 200);
    if (!normalizedRecordId || !normalizedRouteId || !fs.existsSync(this.deliveryRoot)) return undefined;
    const files = fs.readdirSync(this.deliveryRoot, { withFileTypes: true })
      .filter(item => item.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(item.name))
      .map(item => path.join(this.deliveryRoot, item.name))
      .sort((left, right) => right.localeCompare(left));
    for (const filePath of files) {
      const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).reverse();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const receipt = JSON.parse(line) as SpeechRouteDeliveryReceipt;
          if (
            receipt?.schemaVersion === 1
            && receipt.recordId === normalizedRecordId
            && receipt.routeId === normalizedRouteId
            && (receipt.status === "delivered" || receipt.status === "recorded")
          ) return receipt;
        } catch {
          // Ignore malformed historical rows and continue looking for a valid receipt.
        }
      }
    }
    return undefined;
  }

  listDeliveryReceipts(recordId: string): SpeechRouteDeliveryReceipt[] {
    const normalizedRecordId = oneLine(recordId, 200);
    if (!normalizedRecordId || !fs.existsSync(this.deliveryRoot)) return [];
    const latestByRoute = new Map<string, SpeechRouteDeliveryReceipt>();
    const files = fs.readdirSync(this.deliveryRoot, { withFileTypes: true })
      .filter(item => item.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(item.name))
      .map(item => path.join(this.deliveryRoot, item.name))
      .sort((left, right) => right.localeCompare(left));
    for (const filePath of files) {
      const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).reverse();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const receipt = JSON.parse(line) as SpeechRouteDeliveryReceipt;
          if (
            receipt?.schemaVersion === 1
            && receipt.recordId === normalizedRecordId
            && receipt.routeId
            && (receipt.status === "delivered" || receipt.status === "recorded")
            && !latestByRoute.has(receipt.routeId)
          ) latestByRoute.set(receipt.routeId, receipt);
        } catch {
          // Ignore malformed historical rows.
        }
      }
    }
    return [...latestByRoute.values()].sort((left, right) => left.routeId.localeCompare(right.routeId));
  }

  appendDeliveryReceipt(receipt: SpeechRouteDeliveryReceipt): SpeechRouteDeliveryReceipt {
    const recordId = oneLine(receipt.recordId, 200);
    const routeId = oneLine(receipt.routeId, 200);
    if (!recordId || !routeId) throw new Error("Speech delivery receipt requires recordId and routeId.");
    const lockPath = path.join(this.deliveryRoot, ".locks", `${encodeURIComponent(recordId)}--${encodeURIComponent(routeId)}.lock`);
    return withFileLockSync(lockPath, () => {
      const existing = this.readDeliveryReceipt(recordId, routeId);
      if (existing) return existing;
      const completedAt = new Date(receipt.completedAt || Date.now()).toISOString();
      const normalized: SpeechRouteDeliveryReceipt = {
        schemaVersion: 1,
        recordId,
        routeId,
        messageAdapterType: receipt.messageAdapterType === "rabilink" ? "rabilink" : "speech",
        status: receipt.status,
        reason: oneLine(receipt.reason, 500) || undefined,
        detail: String(receipt.detail ?? "").trim().slice(0, 2_000) || undefined,
        completedAt
      };
      fs.mkdirSync(this.deliveryRoot, { recursive: true });
      withFileLockSync(path.join(this.deliveryRoot, ".delivery-append.lock"), () => {
        fs.appendFileSync(
          path.join(this.deliveryRoot, `${completedAt.slice(0, 10)}.jsonl`),
          `${JSON.stringify(normalized)}\n`,
          "utf8"
        );
      });
      return normalized;
    });
  }
}

function segmentSpeaker(segment: SpeechTranscriptSegment): string {
  return oneLine(
    segment.voiceprintId
    || segment.speakerClusterId
    || segment.speakerLabel
    || segment.speaker
  ) || "未知声纹";
}

export function speechIngressDisplayText(record: SpeechIngressRecord): string {
  if (!record.segments.length) return record.text;
  const turns: Array<{ speaker: string; text: string }> = [];
  for (const segment of record.segments) {
    const speaker = segmentSpeaker(segment);
    const previous = turns[turns.length - 1];
    if (previous?.speaker === speaker) {
      previous.text = `${previous.text} ${segment.text}`.trim();
    } else {
      turns.push({ speaker, text: segment.text.trim() });
    }
  }
  const meaningfulSpeakers = new Set(turns.map(turn => turn.speaker));
  if (meaningfulSpeakers.size === 1 && meaningfulSpeakers.has("未知声纹")) return record.text;
  return turns.map(turn => `${turn.speaker}：${turn.text}`).join("\n");
}

export function speechIngressSingleSpeakerMetadata(record: SpeechIngressRecord): Partial<{
  speakerId: string;
  speakerConfidence: number;
  speakerDecision: string;
  voiceprintId: string;
}> {
  const identified = record.segments.filter(segment =>
    Boolean(segment.voiceprintId || segment.speakerClusterId)
  );
  const identities = new Set(identified.map(segment =>
    segment.voiceprintId || segment.speakerClusterId || ""
  ));
  if (identities.size !== 1 || !identified.length) return {};
  const segment = identified[0];
  const voiceprintId = segment.voiceprintId || segment.speakerClusterId;
  return {
    // Keep the legacy top-level field as an opaque compatibility alias. Host
    // profile/candidate ids remain segment diagnostics and must not enter the
    // Route/persona identity context.
    speakerId: voiceprintId,
    speakerConfidence: segment.speakerScore,
    speakerDecision: segment.speakerDecision || undefined,
    voiceprintId
  };
}
