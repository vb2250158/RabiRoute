import fs from "node:fs";
import path from "node:path";
import type { ForwardDeliveryResult } from "./forwarding.js";
import type { ForwardRecord, ForwardRouteKind, ForwardTemplateValues } from "./routing/types.js";
import type { RabiMessageSource, RabiDeliveryEnvelope } from "./shared/rabiMessage.js";
import type { NotificationRule } from "./config.js";
import type { AgentRecipientDefinition } from "./shared/agentDeliveryTarget.js";
import { recordDataMutationAudit } from "./observability/dataMutationAudit.js";

export const deliveryReplayLedgerFileName = "delivery-replay-ledger.jsonl";

export type DeliveryReplayAttempt = {
  attemptId: string;
  time: number;
  routeKind: ForwardRouteKind;
  messageId: string;
  record: ForwardRecord;
  extraValues: ForwardTemplateValues;
  packets: DeliveryReplayPacket[];
  result: ForwardDeliveryResult;
  replayOfAttemptId?: string;
};

export type DeliveryReplayPacket = {
  routeId: string;
  ruleId: string;
  message: string;
  messageSource?: RabiMessageSource;
  content?: string;
  rule?: NotificationRule;
  recipients?: AgentRecipientDefinition[];
  ownerFingerprint?: string;
  delivery?: RabiDeliveryEnvelope;
  model?: string;
};

export type DeliveryReplayListOptions = {
  status?: ForwardDeliveryResult["status"];
  limit?: number;
};

export type DeliveryReplayLedgerDiagnostic = Readonly<{
  lineNumber: number;
  attemptId?: string;
  code: "invalid_json" | "invalid_attempt";
  message: string;
}>;

export type DeliveryReplayLedgerSnapshot = Readonly<{
  attempts: DeliveryReplayAttempt[];
  diagnostics: readonly DeliveryReplayLedgerDiagnostic[];
  partial: boolean;
}>;

export class DeliveryReplayLedgerIncompleteError extends Error {
  readonly code = "delivery_replay_ledger_incomplete";
  constructor(readonly diagnostics: readonly DeliveryReplayLedgerDiagnostic[]) {
    super(`Delivery replay ledger is incomplete at lines ${diagnostics.map(row => row.lineNumber).join(", ")}. Read the ledger snapshot diagnostics before replaying a batch.`);
  }
}

export function deliveryReplayLedgerPath(dataDir: string): string {
  return path.join(dataDir, deliveryReplayLedgerFileName);
}

export function createDeliveryReplayAttemptId(routeKind: ForwardRouteKind, messageId: string): string {
  const safeMessageId = messageId.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80) || "unknown";
  return `${routeKind}-${safeMessageId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function appendDeliveryReplayAttempt(dataDir: string, attempt: DeliveryReplayAttempt): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(deliveryReplayLedgerPath(dataDir), `${JSON.stringify(attempt)}\n`, "utf8");
  } catch (error) {
    recordDataMutationAudit({
      level: "error",
      group: "delivery",
      event: "delivery_replay_attempt_append_failed",
      owner: "delivery-replay-ledger",
      action: "append-attempt",
      target: { type: "delivery-attempt", id: attempt.attemptId },
      dataSource: { kind: "ledger", id: deliveryReplayLedgerFileName },
      outcome: "failed",
      error
    });
    throw error;
  }
  recordDataMutationAudit({
    group: "delivery",
    event: "delivery_replay_attempt_appended",
    owner: "delivery-replay-ledger",
    action: "append-attempt",
    target: { type: "delivery-attempt", id: attempt.attemptId },
    dataSource: { kind: "ledger", id: deliveryReplayLedgerFileName },
    outcome: "committed",
    after: { revision: attempt.attemptId },
    result: attempt.result.status
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isDeliveryReplayAttempt(value: unknown): value is DeliveryReplayAttempt {
  if (!isRecord(value) || typeof value.attemptId !== "string" || !value.attemptId.trim()
    || !Number.isFinite(value.time) || typeof value.routeKind !== "string" || !value.routeKind
    || typeof value.messageId !== "string" || !isRecord(value.record) || !isRecord(value.extraValues)
    || !Array.isArray(value.packets) || !isRecord(value.result)) return false;
  const result = value.result;
  return typeof result.status === "string" && Number.isFinite(result.matchedRuleCount) && Number.isFinite(result.sentPacketCount)
    && Array.isArray(result.adapterOutcomes) && result.adapterOutcomes.every(outcome => isRecord(outcome) && typeof outcome.status === "string")
    && value.packets.every(packet => isRecord(packet) && typeof packet.routeId === "string"
      && typeof packet.ruleId === "string" && typeof packet.message === "string");
}

export function readDeliveryReplayLedger(dataDir: string): DeliveryReplayLedgerSnapshot {
  const filePath = deliveryReplayLedgerPath(dataDir);
  let content: string;
  try { content = fs.readFileSync(filePath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { attempts: [], diagnostics: [], partial: false };
    throw error;
  }
  const attempts: DeliveryReplayAttempt[] = [], diagnostics: DeliveryReplayLedgerDiagnostic[] = [];
  content.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch {
      diagnostics.push({ lineNumber: index + 1, code: "invalid_json", message: "Delivery replay ledger row is invalid JSON." });
      return;
    }
    if (!isDeliveryReplayAttempt(value)) {
      diagnostics.push({ lineNumber: index + 1, code: "invalid_attempt", message: "Delivery replay ledger row has an invalid attempt structure.",
        ...(isRecord(value) && typeof value.attemptId === "string" && value.attemptId ? { attemptId: value.attemptId } : {}) });
      return;
    }
    attempts.push(value);
  });
  return { attempts, diagnostics, partial: diagnostics.length > 0 };
}

/** Whole-ledger consumers must not mistake a partial read for complete evidence. */
export function readDeliveryReplayAttempts(dataDir: string): DeliveryReplayAttempt[] {
  const snapshot = readDeliveryReplayLedger(dataDir);
  if (snapshot.partial) throw new DeliveryReplayLedgerIncompleteError(snapshot.diagnostics);
  return snapshot.attempts;
}

export function listDeliveryReplayAttemptSnapshot(dataDir: string, options: DeliveryReplayListOptions = {}): DeliveryReplayLedgerSnapshot {
  const snapshot = readDeliveryReplayLedger(dataDir);
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  return { ...snapshot, attempts: snapshot.attempts.filter(attempt => !options.status || attempt.result.status === options.status).slice(-limit).reverse() };
}

export function listDeliveryReplayAttempts(dataDir: string, options: DeliveryReplayListOptions = {}): DeliveryReplayAttempt[] {
  const snapshot = listDeliveryReplayAttemptSnapshot(dataDir, options);
  if (snapshot.partial) throw new DeliveryReplayLedgerIncompleteError(snapshot.diagnostics);
  return snapshot.attempts;
}

export function findDeliveryReplayAttempt(dataDir: string, attemptId: string): DeliveryReplayAttempt | null {
  const normalized = attemptId.trim();
  if (!normalized) {
    return null;
  }
  const { attempts, diagnostics } = readDeliveryReplayLedger(dataDir);
  const targetErrors = diagnostics.filter(row => row.attemptId === normalized);
  if (targetErrors.length) throw new DeliveryReplayLedgerIncompleteError(targetErrors);
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index].attemptId === normalized) {
      return attempts[index];
    }
  }
  const unknownErrors = diagnostics.filter(row => !row.attemptId);
  if (unknownErrors.length) throw new DeliveryReplayLedgerIncompleteError(unknownErrors);
  return null;
}
