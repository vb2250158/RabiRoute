import type { AgentReplyRequest, AgentReplyResult } from "../outbox.js";
import {
  durableDeliveryReceiptPath,
  executeDurableDelivery,
  normalizeDurableDeliveryId,
  readDurableDeliveryReceipt,
  type DurableDeliveryReceipt
} from "./durableDeliveryIdempotency.js";

export type AgentReplyReceipt = DurableDeliveryReceipt<AgentReplyResult>;

export type AgentReplyIdempotencyInfo = {
  deliveryId: string;
  state: "completed" | "in_progress" | "uncertain" | "conflict";
  duplicate: boolean;
};

export type IdempotentAgentReplyBody = AgentReplyResult & {
  idempotency: AgentReplyIdempotencyInfo;
};

export type IdempotentAgentReplyResponse = {
  statusCode: number;
  body: IdempotentAgentReplyBody;
};

type ExecuteOptions = {
  rootDir: string;
  deliver: () => Promise<AgentReplyResult>;
  waitForCompletionMs?: number;
};

const RECEIPT_NAMESPACE = "agent-reply-idempotency";

export function agentReplyReceiptPath(rootDir: string, deliveryId: string): string {
  return durableDeliveryReceiptPath(rootDir, RECEIPT_NAMESPACE, deliveryId);
}

export function readAgentReplyReceipt(rootDir: string, deliveryId: string): AgentReplyReceipt | null {
  return readDurableDeliveryReceipt<AgentReplyResult>(rootDir, RECEIPT_NAMESPACE, deliveryId);
}

function statusCodeFor(result: AgentReplyResult): number {
  if (result.status === "sent") return 202;
  if (result.status === "draft") return 200;
  if (result.status === "failed") return 502;
  return 403;
}

function completedResponse(
  deliveryId: string,
  result: AgentReplyResult,
  duplicate: boolean
): IdempotentAgentReplyResponse {
  return {
    statusCode: statusCodeFor(result),
    body: {
      ...result,
      idempotency: { deliveryId, state: "completed", duplicate }
    }
  };
}

function nonTerminalResponse(
  deliveryId: string,
  state: "in_progress" | "uncertain" | "conflict",
  reason: string,
  statusCode: number,
  duplicate = true
): IdempotentAgentReplyResponse {
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

export async function executeIdempotentAgentReply(
  request: AgentReplyRequest,
  options: ExecuteOptions
): Promise<IdempotentAgentReplyResponse> {
  const deliveryId = normalizeDurableDeliveryId(request.deliveryId);
  const { deliveryId: _deliveryId, ...payload } = request;
  const outcome = await executeDurableDelivery({
    rootDir: options.rootDir,
    namespace: RECEIPT_NAMESPACE,
    deliveryId,
    payload,
    deliver: options.deliver,
    waitForCompletionMs: options.waitForCompletionMs
  });
  if (outcome.state === "completed") {
    return completedResponse(deliveryId, outcome.result, outcome.duplicate);
  }
  return nonTerminalResponse(
    deliveryId,
    outcome.state,
    outcome.reason,
    outcome.state === "uncertain" && !outcome.duplicate ? 503 : 409,
    outcome.duplicate
  );
}

export function agentReplyReceiptResponse(rootDir: string, deliveryId: string): IdempotentAgentReplyResponse {
  const normalized = normalizeDurableDeliveryId(deliveryId);
  const receipt = readAgentReplyReceipt(rootDir, normalized);
  if (!receipt) return nonTerminalResponse(normalized, "uncertain", "No idempotency receipt exists for this deliveryId.", 404);
  if (receipt.state === "completed") {
    const result = receipt.result ?? { ok: false, status: "failed", reason: "Completed idempotency receipt has no result." };
    return completedResponse(normalized, result, true);
  }
  if (receipt.state === "uncertain") {
    return nonTerminalResponse(normalized, "uncertain", receipt.error || "The reply result is uncertain; do not resend automatically.", 409);
  }
  return nonTerminalResponse(normalized, "in_progress", "The reply is reserved or sending; query again before any retry.", 202);
}
