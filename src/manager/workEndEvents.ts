import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import {
  WORK_END_EVENT_MAX_SUMMARY_CHARS,
  WORK_END_EVENT_SCHEMA_VERSION,
  type WorkEndConsumerReceipt,
  type WorkEndedEvent,
  type WorkEndedEventInput,
  type WorkEndReceipt,
  type WorkEndStatus
} from "../shared/workEndEventContract.js";

const MAX_RECENT_RECORDS = 80;
const MAX_SEEN_IDS = 4_096;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,239}$/;
const SAFE_SOURCE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SAFE_PERSONA_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SENSITIVE_VALUE_PATTERN = /\b(token|password|passwd|secret|api[_-]?key|cookie|authorization|bearer)\b\s*[:=：]\s*([^\s,;，；]+)/gi;

type WorkEndEventIndex = {
  recordClass: "index";
  sourceOfTruth: string;
  stableId: "id";
  orderBy: "receivedAt";
  activityAt: "receivedAt";
  action: "rotate";
  sourceRetention: "retained";
  seenIds: string[];
  recent: WorkEndedEvent[];
};

export function workEndEventDataRoot(): string {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "RabiPC", "RabiRoute", "work-events");
}
function emptyIndex(root: string): WorkEndEventIndex {
  return {
    recordClass: "index",
    sourceOfTruth: path.join(root, "events", "YYYY-MM-DD.jsonl"),
    stableId: "id",
    orderBy: "receivedAt",
    activityAt: "receivedAt",
    action: "rotate",
    sourceRetention: "retained",
    seenIds: [],
    recent: []
  };
}

function readIndex(root: string): WorkEndEventIndex {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "event-index.json"), "utf8")) as Partial<WorkEndEventIndex>;
    const fallback = emptyIndex(root);
    return {
      ...fallback,
      seenIds: Array.isArray(raw.seenIds) ? raw.seenIds.filter((id): id is string => typeof id === "string").slice(-MAX_SEEN_IDS) : [],
      recent: Array.isArray(raw.recent) ? raw.recent.slice(0, MAX_RECENT_RECORDS) as WorkEndedEvent[] : []
    };
  } catch {
    return emptyIndex(root);
  }
}

export class WorkEndEventLedger {
  constructor(private readonly root = workEndEventDataRoot()) {}

  has(id: string): boolean {
    return readIndex(this.root).seenIds.includes(id);
  }

  list(limit = 20): WorkEndedEvent[] {
    return readIndex(this.root).recent.slice(0, Math.max(1, Math.min(MAX_RECENT_RECORDS, Math.trunc(limit) || 20)));
  }

  append(event: WorkEndedEvent): void {
    const index = readIndex(this.root);
    const shard = path.join(this.root, "events", `${event.receivedAt.slice(0, 10)}.jsonl`);
    fs.mkdirSync(path.dirname(shard), { recursive: true });
    fs.appendFileSync(shard, `${JSON.stringify(event)}\n`, "utf8");
    const seenIds = [...index.seenIds.filter(id => id !== event.id), event.id].slice(-MAX_SEEN_IDS);
    const recent = [event, ...index.recent.filter(item => item.id !== event.id)].slice(0, MAX_RECENT_RECORDS);
    atomicWriteFileSync(path.join(this.root, "event-index.json"), `${JSON.stringify({ ...index, seenIds, recent }, null, 2)}\n`);
  }
}

function cleanText(value: unknown, maxChars: number): string {
  return String(value || "")
    .replace(SENSITIVE_VALUE_PATTERN, "$1：----")
    .replace(/\r\n?/g, "\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function requiredSafe(value: unknown, pattern: RegExp, name: string): string {
  const normalized = String(value || "").trim();
  if (!pattern.test(normalized)) throw new Error(`Work-ended ${name} is invalid.`);
  return normalized;
}

function normalizedStatus(value: unknown): WorkEndStatus {
  if (value === "completed" || value === "failed" || value === "cancelled") return value;
  throw new Error("Work-ended status is invalid.");
}

function normalizeEvent(input: WorkEndedEventInput, now: Date): WorkEndedEvent {
  const source = requiredSafe(input.source, SAFE_SOURCE_PATTERN, "source");
  const sessionId = cleanText(input.sessionId, 200);
  if (!sessionId) throw new Error("Work-ended sessionId is required.");
  const summary = cleanText(input.summary, WORK_END_EVENT_MAX_SUMMARY_CHARS);
  if (!summary) throw new Error("Work-ended summary is required.");
  const turnId = cleanText(input.turnId, 200);
  const suppliedId = String(input.id || "").trim();
  const id = suppliedId
    ? requiredSafe(suppliedId, SAFE_ID_PATTERN, "id")
    : `${source}:${crypto.createHash("sha256").update(`${sessionId}\n${turnId}\n${summary}`).digest("hex").slice(0, 24)}`;
  const receivedAt = now.toISOString();
  const occurredAtCandidate = String(input.occurredAt || "").trim();
  const occurredAt = occurredAtCandidate && !Number.isNaN(Date.parse(occurredAtCandidate))
    ? new Date(occurredAtCandidate).toISOString()
    : receivedAt;
  const personaCandidate = String(input.personaId || "").trim();
  const personaId = personaCandidate ? requiredSafe(personaCandidate, SAFE_PERSONA_PATTERN, "personaId") : "";
  const taskName = cleanText(input.taskName, 160);
  return {
    schemaVersion: WORK_END_EVENT_SCHEMA_VERSION,
    id,
    source,
    sessionId,
    turnId,
    personaId,
    status: normalizedStatus(input.status),
    summary,
    ...(taskName ? { taskName } : {}),
    isChild: input.isChild === true,
    occurredAt,
    receivedAt
  };
}

export type WorkEndEventServiceDependencies = {
  ledger: WorkEndEventLedger;
  publish: (event: WorkEndedEvent) => void;
  announce: (event: WorkEndedEvent) => Promise<WorkEndConsumerReceipt>;
  now?: () => Date;
};

export class WorkEndEventService {
  private readonly now: () => Date;

  constructor(private readonly dependencies: WorkEndEventServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  records(limit?: number): WorkEndedEvent[] {
    return this.dependencies.ledger.list(limit);
  }

  async accept(input: WorkEndedEventInput): Promise<WorkEndReceipt> {
    const event = normalizeEvent(input, this.now());
    if (this.dependencies.ledger.has(event.id)) {
      return { accepted: true, duplicate: true, eventId: event.id, consumers: {} };
    }
    this.dependencies.ledger.append(event);
    this.dependencies.publish(event);
    let announcement: WorkEndConsumerReceipt;
    try {
      announcement = await this.dependencies.announce(event);
    } catch (error) {
      announcement = { handled: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return {
      accepted: true,
      duplicate: false,
      eventId: event.id,
      consumers: { announcement }
    };
  }
}
