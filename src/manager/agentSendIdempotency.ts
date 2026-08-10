import { prepareAgentSendRequest, type AgentSendRequest, type AgentSendResult } from "../agentSend.js";
import {
  durableDeliveryReceiptPath,
  executeDurableDelivery,
  normalizeDurableDeliveryId,
  readDurableDeliveryReceipt,
  type DurableDeliveryReceipt
} from "./durableDeliveryIdempotency.js";

export type AgentSendReceipt = DurableDeliveryReceipt<AgentSendResult>;

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

export function agentSendReceiptPath(rootDir: string, deliveryId: string): string {
  return durableDeliveryReceiptPath(rootDir, RECEIPT_NAMESPACE, deliveryId);
}

export function readAgentSendReceipt(rootDir: string, deliveryId: string): AgentSendReceipt | null {
  return readDurableDeliveryReceipt<AgentSendResult>(rootDir, RECEIPT_NAMESPACE, deliveryId);
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
  prepareAgentSendRequest(request);
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
  if (outcome.state === "completed") return completedResponse(deliveryId, outcome.result, outcome.duplicate);
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
