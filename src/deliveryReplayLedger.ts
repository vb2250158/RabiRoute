import fs from "node:fs";
import path from "node:path";
import type { ForwardDeliveryResult } from "./forwarding.js";
import type { ForwardRecord, ForwardRouteKind, ForwardTemplateValues } from "./routing/types.js";

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
};

export type DeliveryReplayListOptions = {
  status?: ForwardDeliveryResult["status"];
  limit?: number;
};

export function deliveryReplayLedgerPath(dataDir: string): string {
  return path.join(dataDir, deliveryReplayLedgerFileName);
}

export function createDeliveryReplayAttemptId(routeKind: ForwardRouteKind, messageId: string): string {
  const safeMessageId = messageId.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80) || "unknown";
  return `${routeKind}-${safeMessageId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function appendDeliveryReplayAttempt(dataDir: string, attempt: DeliveryReplayAttempt): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(deliveryReplayLedgerPath(dataDir), `${JSON.stringify(attempt)}\n`, "utf8");
}

export function readDeliveryReplayAttempts(dataDir: string): DeliveryReplayAttempt[] {
  const filePath = deliveryReplayLedgerPath(dataDir);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DeliveryReplayAttempt);
}

export function listDeliveryReplayAttempts(dataDir: string, options: DeliveryReplayListOptions = {}): DeliveryReplayAttempt[] {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const attempts = readDeliveryReplayAttempts(dataDir)
    .filter((attempt) => !options.status || attempt.result.status === options.status);
  return attempts.slice(-limit).reverse();
}

export function findDeliveryReplayAttempt(dataDir: string, attemptId: string): DeliveryReplayAttempt | null {
  const normalized = attemptId.trim();
  if (!normalized) {
    return null;
  }
  const attempts = readDeliveryReplayAttempts(dataDir);
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index].attemptId === normalized) {
      return attempts[index];
    }
  }
  return null;
}
