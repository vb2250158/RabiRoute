import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { appendAdapterLogToDir } from "./history.js";
import {
  deliverPacketToPrimaryAgentAdapter,
  forwardMessageAndWait,
  type ForwardAdapterOutcome,
  type ForwardDeliveryResult
} from "./forwarding.js";
import {
  appendDeliveryReplayAttempt,
  createDeliveryReplayAttemptId,
  findDeliveryReplayAttempt,
  listDeliveryReplayAttempts,
  type DeliveryReplayAttempt
} from "./deliveryReplayLedger.js";
import type { ForwardRecord, ForwardRouteKind } from "./routing/types.js";
import {
  normalizeRabiMessageContent,
  rabiMessageSourceLines,
  renderRabiDelivery,
  type RabiDeliveryEnvelope
} from "./shared/rabiMessage.js";

export type DeliveryReplayMode = "single" | "merge";

export type DeliveryReplayRequest = {
  attemptId?: string;
  attemptIds?: string[];
  routeKind?: ForwardRouteKind;
  messageId?: string;
  mode?: DeliveryReplayMode;
};

export type DeliveryReplayResult = {
  ok: boolean;
  mode: DeliveryReplayMode;
  replayedAttemptIds: string[];
  result?: ForwardDeliveryResult;
  adapterOutcomes?: ForwardAdapterOutcome[];
  error?: string;
};

export function listFailedDeliveryReplayAttempts(dataDir: string, limit = 50): DeliveryReplayAttempt[] {
  return listDeliveryReplayAttempts(dataDir, { status: "failed", limit });
}

export async function replayDeliveryAttempts(dataDir: string, request: DeliveryReplayRequest): Promise<DeliveryReplayResult> {
  const attemptIds = normalizeAttemptIds(request);
  if (attemptIds.length === 0 && request.routeKind && request.messageId) {
    return replayStoredDeliveryRecord(dataDir, request.routeKind, request.messageId);
  }
  if (attemptIds.length === 0) {
    return { ok: false, mode: request.mode ?? "single", replayedAttemptIds: [], error: "No delivery replay attempt id was provided." };
  }

  const attempts = attemptIds.map((attemptId) => {
    const attempt = findDeliveryReplayAttempt(dataDir, attemptId);
    if (!attempt) {
      throw new Error(`Delivery replay attempt not found: ${attemptId}`);
    }
    return attempt;
  });

  const mode = request.mode ?? (attempts.length > 1 ? "merge" : "single");
  return mode === "merge"
    ? replayMergedDeliveryAttempts(dataDir, attempts)
    : replaySingleDeliveryAttempt(dataDir, attempts[0]);
}

async function replayStoredDeliveryRecord(dataDir: string, routeKind: ForwardRouteKind, messageId: string): Promise<DeliveryReplayResult> {
  const record = findStoredRecord(routeKind, messageId);
  if (!record) {
    return {
      ok: false,
      mode: "single",
      replayedAttemptIds: [],
      error: `Stored ${routeKind} record not found: ${messageId}`
    };
  }

  const result = await forwardMessageAndWait(routeKind, record, {}, {
    appendRoleRecord: false,
    replayOfAttemptId: `stored:${routeKind}:${messageId}`
  });
  appendAdapterLogToDir("router", {
    event: "delivery_replay",
    level: result.status === "failed" ? "error" : "info",
    message: `Delivery replay ${result.status} mode=stored routeKind=${routeKind} messageId=${messageId}`,
    data: { mode: "stored", routeKind, messageId, result }
  }, dataDir);

  return {
    ok: result.status !== "failed",
    mode: "single",
    replayedAttemptIds: [`stored:${routeKind}:${messageId}`],
    result
  };
}

function findStoredRecord(routeKind: ForwardRouteKind, messageId: string): ForwardRecord | null {
  const fileName = recordFileNameForRouteKind(routeKind);
  if (!fileName) {
    return null;
  }

  const filePath = path.join(config.memoryDataDir, fileName);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const records = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ForwardRecord);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (String(records[index].messageId ?? "") === messageId) {
      return records[index];
    }
  }
  return null;
}

function recordFileNameForRouteKind(routeKind: ForwardRouteKind): string | null {
  if (routeKind === "private") return "private-messages.jsonl";
  if (routeKind === "group_message" || routeKind === "direct_at" || routeKind === "direct_reply" || routeKind === "indirect_reply") return "group-messages.jsonl";
  if (routeKind === "heartbeat") return "heartbeat-events.jsonl";
  if (routeKind === "manual_trigger") return "manual-trigger-events.jsonl";
  if (routeKind === "voice_transcript") return "voice-transcripts.jsonl";
  if (routeKind === "rabilink") return "rabilink-voice-transcripts.jsonl";
  return null;
}

function normalizeAttemptIds(request: DeliveryReplayRequest): string[] {
  const raw = request.attemptIds?.length ? request.attemptIds : request.attemptId ? [request.attemptId] : [];
  return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
}

async function replaySingleDeliveryAttempt(dataDir: string, attempt: DeliveryReplayAttempt): Promise<DeliveryReplayResult> {
  if (!attempt.packets.length || attempt.packets.some(packet => !packet.rule?.agentTarget || !packet.recipients || !packet.ownerFingerprint)) {
    return { ok: false, mode: "single", replayedAttemptIds: [], error: "The historical delivery has no recorded target. Select a destination explicitly instead of replaying to the current primary Agent." };
  }
  const activeRoutes = new Set(config.routeProfiles.map(route => route.id));
  if (attempt.packets.some(packet => !activeRoutes.has(packet.routeId))) {
    return { ok: false, mode: "single", replayedAttemptIds: [], error: "The original route is unavailable; replay cannot substitute another route." };
  }
  const result = await forwardMessageAndWait(attempt.routeKind, attempt.record, attempt.extraValues, {
    appendRoleRecord: false, replayOfAttemptId: attempt.attemptId, replayPackets: attempt.packets
  });
  appendAdapterLogToDir("router", { event: "delivery_replay", level: result.status === "failed" ? "error" : "info",
    message: "Delivery replay kept the original targets", data: { replayOfAttemptId: attempt.attemptId, result } }, dataDir);
  return { ok: result.status === "delivered", mode: "single", replayedAttemptIds: [attempt.attemptId], result };
}

async function replayMergedDeliveryAttempts(dataDir: string, attempts: DeliveryReplayAttempt[]): Promise<DeliveryReplayResult> {
  // Batch retry preserves each original identity; combining prompts would create a new delivery.
  const replies: DeliveryReplayResult[] = [];
  for (const attempt of attempts) replies.push(await replaySingleDeliveryAttempt(dataDir, attempt));
  const results = replies.flatMap(reply => reply.result ? [reply.result] : []);
  const outcomes = results.flatMap(result => result.adapterOutcomes);
  const ok = replies.every(reply => reply.ok);
  const result: ForwardDeliveryResult | undefined = results.length ? {
    routeKind: attempts[0].routeKind, messageId: attempts.map(attempt => attempt.messageId).join(","),
    status: ok ? "delivered" : "failed", routes: results.flatMap(result => result.routes),
    matchedRuleIds: results.flatMap(result => result.matchedRuleIds),
    matchedRuleCount: results.reduce((sum, result) => sum + result.matchedRuleCount, 0),
    sentPacketCount: results.reduce((sum, result) => sum + result.sentPacketCount, 0), adapterOutcomes: outcomes
  } : undefined;
  return { ok, mode: "merge", replayedAttemptIds: replies.flatMap(reply => reply.replayedAttemptIds),
    result, adapterOutcomes: outcomes, error: replies.find(reply => reply.error)?.error };
}
