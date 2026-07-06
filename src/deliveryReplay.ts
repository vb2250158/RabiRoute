import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { appendAdapterLogToDir } from "./history.js";
import {
  deliverPacketToAgentAdapters,
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
  const result = await forwardMessageAndWait(attempt.routeKind, attempt.record, attempt.extraValues, {
    appendRoleRecord: false,
    replayOfAttemptId: attempt.attemptId
  });
  appendAdapterLogToDir("router", {
    event: "delivery_replay",
    level: result.status === "failed" ? "error" : "info",
    message: `Delivery replay ${result.status} mode=single replayOf=${attempt.attemptId}`,
    data: { mode: "single", replayOfAttemptId: attempt.attemptId, result }
  }, dataDir);

  return {
    ok: result.status !== "failed",
    mode: "single",
    replayedAttemptIds: [attempt.attemptId],
    result
  };
}

async function replayMergedDeliveryAttempts(dataDir: string, attempts: DeliveryReplayAttempt[]): Promise<DeliveryReplayResult> {
  const packets = attempts.flatMap((attempt) => attempt.packets.map((packet) => ({ attempt, packet })));
  if (packets.length === 0) {
    return {
      ok: false,
      mode: "merge",
      replayedAttemptIds: attempts.map((attempt) => attempt.attemptId),
      error: "Selected delivery attempts do not contain replayable agent packets."
    };
  }

  const message = buildMergedReplayMessage(attempts);
  const outcomes = await deliverPacketToAgentAdapters("delivery-replay", "merged", message);
  const failed = outcomes.some((outcome) => outcome.status === "failed");
  const delivered = outcomes.some((outcome) => outcome.status === "delivered");
  const status: ForwardDeliveryResult["status"] = failed ? "failed" : delivered ? "delivered" : "routed";
  const result: ForwardDeliveryResult = {
    routeKind: attempts[0].routeKind,
    messageId: attempts.map((attempt) => attempt.messageId).join(","),
    status,
    matchedRuleIds: ["merged"],
    matchedRuleCount: attempts.length,
    sentPacketCount: 1,
    adapterOutcomes: outcomes,
    routes: [{
      routeId: "delivery-replay",
      routeName: "Delivery Replay",
      status,
      matchedRuleIds: ["merged"],
      matchedRuleCount: attempts.length,
      sentPacketCount: 1,
      adapterOutcomes: outcomes
    }]
  };

  appendDeliveryReplayAttempt(dataDir, {
    attemptId: createDeliveryReplayAttemptId("manual_trigger", `merged-${Date.now()}`),
    time: Math.floor(Date.now() / 1000),
    routeKind: "manual_trigger",
    messageId: result.messageId,
    record: {
      time: Math.floor(Date.now() / 1000),
      rawMessage: message,
      messageId: result.messageId,
      senderName: "RabiRoute Delivery Replay",
      triggerId: "delivery-replay",
      triggerName: "Delivery Replay"
    },
    extraValues: {},
    packets: [{ routeId: "delivery-replay", ruleId: "merged", message }],
    result,
    replayOfAttemptId: attempts.map((attempt) => attempt.attemptId).join(",")
  });

  appendAdapterLogToDir("router", {
    event: "delivery_replay",
    level: failed ? "error" : "info",
    message: `Delivery replay ${status} mode=merge count=${attempts.length}`,
    data: { mode: "merge", replayOfAttemptIds: attempts.map((attempt) => attempt.attemptId), result }
  }, dataDir);

  return {
    ok: !failed,
    mode: "merge",
    replayedAttemptIds: attempts.map((attempt) => attempt.attemptId),
    result,
    adapterOutcomes: outcomes
  };
}

function buildMergedReplayMessage(attempts: DeliveryReplayAttempt[]): string {
  const sections = attempts.map((attempt, index) => {
    const packetText = attempt.packets.map((packet) => packet.message).join("\n\n");
    return [
      `## 漏投消息 ${index + 1}`,
      `attemptId: ${attempt.attemptId}`,
      `routeKind: ${attempt.routeKind}`,
      `messageId: ${attempt.messageId}`,
      `time: ${attempt.time}`,
      "",
      packetText
    ].join("\n");
  });

  return [
    "# RabiRoute 投递重放合集",
    "",
    "下面是之前已经进入 RabiRoute、但投递到 agent 下游失败的消息。请把它们作为同一段连续上下文处理；不要因为这是重放就自动向 QQ 或外部系统发送消息，所有外发仍需走原有安全门。",
    "",
    ...sections
  ].join("\n");
}
