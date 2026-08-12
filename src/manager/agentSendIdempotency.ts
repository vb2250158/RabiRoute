import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { prepareAgentSendRequest, type AgentSendRequest, type AgentSendResult } from "../agentSend.js";
import {
  durableDeliveryReceiptPath,
  executeDurableDelivery,
  normalizeDurableDeliveryId,
  readDurableDeliveryReceipt,
  type DurableDeliveryReceipt
} from "./durableDeliveryIdempotency.js";

export type AgentSendReceipt = DurableDeliveryReceipt<AgentSendResult>;

export type AgentSendTrace = {
  deliveryId: string;
  createdAt: string;
  updatedAt: string;
  result: AgentSendResult;
};

export type AgentSendTraceQuery = {
  channel?: unknown;
  sentMessageId?: unknown;
  routeId?: unknown;
};

export type AgentSendIdempotencyInfo = {
  deliveryId: string;
  state: "completed" | "in_progress" | "uncertain" | "conflict";
  duplicate: boolean;
};

export type IdempotentAgentSendBody = AgentSendResult & {
  idempotency: AgentSendIdempotencyInfo;
};

export type IdempotentAgentSendResponse = {
  statusCode: number;
  body: IdempotentAgentSendBody;
};

type ExecuteOptions = {
  rootDir: string;
  deliver: () => Promise<AgentSendResult>;
  waitForCompletionMs?: number;
};

const RECEIPT_NAMESPACE = "agent-send-idempotency";
const MESSAGE_PROCESSING_CONTENT_DEDUPE_MS = 2 * 60 * 1_000;
const RECENT_REPLY_TARGET_DEDUPE_MS = 10 * 60 * 1_000;

type RecentContentSend = {
  promise: Promise<AgentSendResult>;
  expiresAt: number;
};

const recentMessageProcessingSends = new Map<string, RecentContentSend>();

type RecentSuccessfulReply = {
  deliveryId: string;
  fingerprint: string;
  result: AgentSendResult;
  expiresAt: number;
};

const recentSuccessfulReplies = new Map<string, RecentSuccessfulReply>();
const hydratedRecentReplyRoots = new Set<string>();

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizedContentPayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const payload = value as Record<string, unknown>;
  if (payload.type !== "text" || typeof payload.text !== "string") return payload;
  return {
    ...payload,
    text: payload.text.trim().replace(/\s+/g, " ")
  };
}

function messageProcessingContentKey(
  rootDir: string,
  prepared: ReturnType<typeof prepareAgentSendRequest>,
  request: AgentSendRequest
): string | undefined {
  if (prepared.sender.agentType !== "message_processing") return undefined;
  const fingerprint = stableJson({
    routeId: prepared.routeId,
    channel: prepared.channel,
    target: prepared.target,
    payload: normalizedContentPayload(request.payload)
  });
  return `${path.resolve(rootDir)}:${createHash("sha256").update(fingerprint, "utf8").digest("hex")}`;
}

function sendContentFingerprint(request: AgentSendRequest): string {
  return createHash("sha256")
    .update(stableJson(normalizedContentPayload(request.payload)), "utf8")
    .digest("hex");
}

function recentReplyTargetKey(
  rootDir: string,
  prepared: ReturnType<typeof prepareAgentSendRequest>
): string | undefined {
  if (prepared.channel !== "napcat") return undefined;
  if (prepared.target.target !== "group") return undefined;
  const groupId = String(prepared.target.groupId ?? "").trim();
  const replyToMessageId = String(prepared.target.replyToMessageId ?? "").trim();
  if (!groupId || !replyToMessageId) return undefined;
  const fingerprint = stableJson({
    routeId: prepared.routeId,
    channel: prepared.channel,
    groupId,
    replyToMessageId
  });
  return `${path.resolve(rootDir)}:${createHash("sha256").update(fingerprint, "utf8").digest("hex")}`;
}

function recentReplyTargetKeyFromResult(rootDir: string, result: AgentSendResult): string | undefined {
  if (result.channel !== "napcat") return undefined;
  const target = result.target;
  if (!target || target.target !== "group") return undefined;
  const groupId = String(target.groupId ?? "").trim();
  const replyToMessageId = String(target.replyToMessageId ?? "").trim();
  const routeId = String(result.routeId ?? "").trim();
  if (!routeId || !groupId || !replyToMessageId) return undefined;
  const fingerprint = stableJson({
    routeId,
    channel: result.channel,
    groupId,
    replyToMessageId
  });
  return `${path.resolve(rootDir)}:${createHash("sha256").update(fingerprint, "utf8").digest("hex")}`;
}

function hydrateRecentSuccessfulReplies(rootDir: string): void {
  const resolvedRoot = path.resolve(rootDir);
  if (hydratedRecentReplyRoots.has(resolvedRoot)) return;
  hydratedRecentReplyRoots.add(resolvedRoot);
  const receiptDir = path.join(resolvedRoot, "data", RECEIPT_NAMESPACE);
  if (!fs.existsSync(receiptDir)) return;
  const now = Date.now();
  for (const fileName of fs.readdirSync(receiptDir)) {
    if (!fileName.endsWith(".json")) continue;
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, fileName), "utf8")) as AgentSendReceipt;
      const result = receipt.state === "completed" ? receipt.result : undefined;
      const updatedAt = Date.parse(String(receipt.updatedAt ?? ""));
      const expiresAt = updatedAt + RECENT_REPLY_TARGET_DEDUPE_MS;
      if (!result || result.status !== "sent" || !Number.isFinite(updatedAt) || expiresAt <= now) continue;
      const key = recentReplyTargetKeyFromResult(resolvedRoot, result);
      if (!key) continue;
      const existing = recentSuccessfulReplies.get(key);
      if (existing && existing.expiresAt >= expiresAt) continue;
      recentSuccessfulReplies.set(key, {
        deliveryId: receipt.deliveryId,
        fingerprint: "",
        result,
        expiresAt
      });
    } catch {
      // Ignore malformed runtime receipts. Exact delivery lookup remains authoritative.
    }
  }
}

function readRecentSuccessfulReply(rootDir: string, key: string | undefined): RecentSuccessfulReply | undefined {
  if (!key) return undefined;
  hydrateRecentSuccessfulReplies(rootDir);
  const existing = recentSuccessfulReplies.get(key);
  if (!existing) return undefined;
  if (existing.expiresAt > Date.now()) return existing;
  recentSuccessfulReplies.delete(key);
  return undefined;
}

function rememberSuccessfulReply(
  key: string | undefined,
  deliveryId: string,
  fingerprint: string,
  result: AgentSendResult
): void {
  if (!key || result.status !== "sent") return;
  const entry: RecentSuccessfulReply = {
    deliveryId,
    fingerprint,
    result,
    expiresAt: Date.now() + RECENT_REPLY_TARGET_DEDUPE_MS
  };
  recentSuccessfulReplies.set(key, entry);
  const cleanupTimer = setTimeout(() => {
    if (recentSuccessfulReplies.get(key) === entry) recentSuccessfulReplies.delete(key);
  }, RECENT_REPLY_TARGET_DEDUPE_MS);
  cleanupTimer.unref?.();
}

async function coalesceMessageProcessingContent(
  key: string | undefined,
  deliver: () => Promise<AgentSendResult>
): Promise<{ duplicate: boolean; result: AgentSendResult }> {
  if (!key) return { duplicate: false, result: await deliver() };
  const now = Date.now();
  const existing = recentMessageProcessingSends.get(key);
  if (existing && existing.expiresAt > now) {
    return { duplicate: true, result: await existing.promise };
  }
  if (existing) recentMessageProcessingSends.delete(key);

  const promise = deliver();
  const entry: RecentContentSend = {
    promise,
    expiresAt: now + MESSAGE_PROCESSING_CONTENT_DEDUPE_MS
  };
  recentMessageProcessingSends.set(key, entry);
  const cleanupTimer = setTimeout(() => {
    if (recentMessageProcessingSends.get(key) === entry) recentMessageProcessingSends.delete(key);
  }, MESSAGE_PROCESSING_CONTENT_DEDUPE_MS);
  cleanupTimer.unref?.();
  try {
    const result = await promise;
    if (result.status !== "sent") recentMessageProcessingSends.delete(key);
    return { duplicate: false, result };
  } catch (error) {
    recentMessageProcessingSends.delete(key);
    throw error;
  }
}

export function agentSendReceiptPath(rootDir: string, deliveryId: string): string {
  return durableDeliveryReceiptPath(rootDir, RECEIPT_NAMESPACE, deliveryId);
}

export function readAgentSendReceipt(rootDir: string, deliveryId: string): AgentSendReceipt | null {
  return readDurableDeliveryReceipt<AgentSendResult>(rootDir, RECEIPT_NAMESPACE, deliveryId);
}

function requiredTraceText(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Missing ${field}.`);
  if (text.length > 500 || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`Invalid ${field}.`);
  return text;
}

export function findAgentSendTraces(rootDir: string, query: AgentSendTraceQuery): AgentSendTrace[] {
  const channel = requiredTraceText(query.channel, "channel");
  const sentMessageId = requiredTraceText(query.sentMessageId, "sentMessageId");
  const routeId = query.routeId == null || String(query.routeId).trim() === ""
    ? undefined
    : requiredTraceText(query.routeId, "routeId");
  const receiptDir = path.join(path.resolve(rootDir), "data", RECEIPT_NAMESPACE);
  if (!fs.existsSync(receiptDir)) return [];
  const matches: AgentSendTrace[] = [];
  for (const fileName of fs.readdirSync(receiptDir)) {
    if (!fileName.endsWith(".json")) continue;
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, fileName), "utf8")) as AgentSendReceipt;
      const result = receipt.state === "completed" ? receipt.result : undefined;
      if (!result || result.channel !== channel || result.sentMessageId !== sentMessageId) continue;
      if (routeId && result.routeId !== routeId) continue;
      matches.push({
        deliveryId: receipt.deliveryId,
        createdAt: receipt.createdAt,
        updatedAt: receipt.updatedAt,
        result
      });
    } catch {
      // Ignore unrelated or unreadable runtime files; exact delivery lookup remains available.
    }
  }
  return matches.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 100);
}

function statusCodeFor(result: AgentSendResult): number {
  if (result.status === "sent") return 202;
  if (result.status === "draft") return 200;
  if (result.status === "failed") return 502;
  return 403;
}

function completedResponse(deliveryId: string, result: AgentSendResult, duplicate: boolean): IdempotentAgentSendResponse {
  return {
    statusCode: statusCodeFor(result),
    body: { ...result, idempotency: { deliveryId, state: "completed", duplicate } }
  };
}

function nonTerminalResponse(
  deliveryId: string,
  state: "in_progress" | "uncertain" | "conflict",
  reason: string,
  statusCode: number,
  duplicate = true
): IdempotentAgentSendResponse {
  return {
    statusCode,
    body: {
      ok: false,
      status: "failed",
      reason,
      idempotency: { deliveryId, state, duplicate }
    }
  };
}

export async function executeIdempotentAgentSend(
  request: AgentSendRequest,
  options: ExecuteOptions
): Promise<IdempotentAgentSendResponse> {
  const prepared = prepareAgentSendRequest(request);
  const deliveryId = normalizeDurableDeliveryId(request.deliveryId);
  const replyTargetKey = recentReplyTargetKey(options.rootDir, prepared);
  const contentFingerprint = sendContentFingerprint(request);
  const recentReply = prepared.allowAdditionalReply ? undefined : readRecentSuccessfulReply(options.rootDir, replyTargetKey);
  if (recentReply) {
    if (recentReply.fingerprint === contentFingerprint) {
      return completedResponse(deliveryId, {
        ...recentReply.result,
        deliveryId,
        sender: prepared.sender,
        channel: prepared.channel,
        routeId: prepared.routeId,
        target: prepared.target
      }, true);
    }
    return nonTerminalResponse(
      deliveryId,
      "conflict",
      `The quoted group message already received a recent reply via deliveryId ${recentReply.deliveryId}. `
        + "Do not send another paraphrase. Set params.allowAdditionalReply=true only when this is intentionally new follow-up information.",
      409,
      true
    );
  }
  const contentKey = messageProcessingContentKey(options.rootDir, prepared, request);
  let contentDuplicate = false;
  const { deliveryId: _deliveryId, ...payload } = request;
  const outcome = await executeDurableDelivery({
    rootDir: options.rootDir,
    namespace: RECEIPT_NAMESPACE,
    deliveryId,
    payload,
    deliver: async () => {
      const coalesced = await coalesceMessageProcessingContent(contentKey, options.deliver);
      contentDuplicate = coalesced.duplicate;
      return {
        ...coalesced.result,
        deliveryId,
        sender: prepared.sender,
        channel: prepared.channel,
        routeId: prepared.routeId,
        target: prepared.target
      };
    },
    waitForCompletionMs: options.waitForCompletionMs
  });
  if (outcome.state === "completed") {
    rememberSuccessfulReply(replyTargetKey, deliveryId, contentFingerprint, outcome.result);
    return completedResponse(deliveryId, outcome.result, outcome.duplicate || contentDuplicate);
  }
  return nonTerminalResponse(
    deliveryId,
    outcome.state,
    outcome.reason,
    outcome.state === "uncertain" && !outcome.duplicate ? 503 : 409,
    outcome.duplicate
  );
}

export function agentSendReceiptResponse(rootDir: string, deliveryId: string): IdempotentAgentSendResponse {
  const normalized = normalizeDurableDeliveryId(deliveryId);
  const receipt = readAgentSendReceipt(rootDir, normalized);
  if (!receipt) return nonTerminalResponse(normalized, "uncertain", "No idempotency receipt exists for this deliveryId.", 404);
  if (receipt.state === "completed") {
    const result = receipt.result ?? {
      ok: false,
      status: "failed",
      reason: "Completed idempotency receipt has no result."
    } satisfies AgentSendResult;
    return completedResponse(normalized, result, true);
  }
  if (receipt.state === "uncertain") {
    return nonTerminalResponse(normalized, "uncertain", receipt.error || "The send result is uncertain; do not resend automatically.", 409);
  }
  return nonTerminalResponse(normalized, "in_progress", "The send is reserved or running; query again before any retry.", 202);
}
