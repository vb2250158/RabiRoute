import fs from "node:fs";
import { prepareAgentSendRequest, type AgentSendRequest, type AgentSendResult } from "../agentSend.js";
import {
  durableDeliveryReceiptPath,
  durableDeliveryRequestDigest,
  normalizeDurableDeliveryId,
  readDurableDeliveryReceiptSnapshot,
  reconcileDurableDelivery,
  type DurableDeliveryReceipt
} from "./durableDeliveryIdempotency.js";

import { AGENT_SEND_RECEIPT_NAMESPACE as RECEIPT_NAMESPACE } from "./agentSendIdempotency.js";

export type AgentSendVerification = {
  platformVerification: "present" | "unknown";
  evidence: unknown;
  originalResult?: AgentSendResult;
  /** Trusted verifier explicitly proved the ENTIRE original terminal delivery,
   * including any caption/secondary message. Mere file presence is insufficient. */
  originalTerminalProven?: true;
};

export type AgentSendReconciliationOptions = {
  rootDir: string;
  /** Internal trusted capability, never populated from HTTP JSON or public callers.
   * Must use authoritative original history and read-only platform evidence. */
  verify: (request: Readonly<AgentSendRequest>, receipt: Readonly<DurableDeliveryReceipt<AgentSendResult>>)
    => Promise<AgentSendVerification>;
};

export type AgentSendReconciliationResponse = {
  statusCode: number;
  body: {
    deliveryId: string;
    platformVerification: "present" | "unknown";
    settlement: "committed" | "not_attempted" | "failed";
    retryAllowed: false;
    deliveredNow: false;
    state: "verified" | "completed" | "missing" | "conflict" | "in_progress" | "uncertain";
    code?: string;
    evidence?: unknown;
    originalResult?: AgentSendResult;
  };
};

function response(deliveryId: string, statusCode: number,
  fields: Partial<AgentSendReconciliationResponse["body"]>): AgentSendReconciliationResponse {
  return { statusCode, body: {
    deliveryId, platformVerification: "unknown", settlement: "not_attempted",
    retryAllowed: false, deliveredNow: false, state: "uncertain", ...fields
  } };
}

function prepareInput(deliveryId: unknown, originalRequest: AgentSendRequest) {
  const normalizedId = normalizeDurableDeliveryId(deliveryId);
  const request = structuredClone(originalRequest);
  if (normalizeDurableDeliveryId(request.deliveryId) !== normalizedId) {
    throw new Error("Original AgentSendRequest deliveryId does not match deliveryId.");
  }
  const prepared = prepareAgentSendRequest(request);
  const { deliveryId: _deliveryId, ...payload } = request;
  return { deliveryId: normalizedId, request, prepared, payload, digest: durableDeliveryRequestDigest(payload) };
}

function readSnapshot(rootDir: string, deliveryId: string) {
  const snapshot = readDurableDeliveryReceiptSnapshot<AgentSendResult>(rootDir, RECEIPT_NAMESPACE, deliveryId);
  if (snapshot) return { snapshot };
  // Only inspect the normalized, hashed receipt path. existsSync masks I/O errors;
  // stat distinguishes an absent path from unavailable storage.
  try {
    fs.statSync(durableDeliveryReceiptPath(rootDir, RECEIPT_NAMESPACE, deliveryId));
    return { failure: response(deliveryId, 409, { state: "conflict", code: "RECEIPT_CORRUPT" }) };
  } catch (error) {
    return { failure: (error as NodeJS.ErrnoException).code === "ENOENT"
      ? response(deliveryId, 404, { state: "missing", code: "RECEIPT_MISSING" })
      : response(deliveryId, 503, { code: "RECEIPT_UNAVAILABLE" }) };
  }
}

function completeOriginalResult(result: AgentSendResult | undefined,
  input: ReturnType<typeof prepareInput>): result is AgentSendResult {
  if (!result || typeof result.ok !== "boolean" || !["sent", "draft", "blocked", "failed"].includes(result.status)
    || result.deliveryId !== input.deliveryId || result.channel !== input.prepared.channel
    || result.routeId !== input.prepared.routeId
    || result.sender?.agentType !== input.prepared.sender.agentType
    || result.sender?.sessionId !== input.prepared.sender.sessionId
    || durableDeliveryRequestDigest(JSON.parse(JSON.stringify(result.target ?? null))) !== durableDeliveryRequestDigest(JSON.parse(JSON.stringify(input.prepared.target)))) return false;
  if (result.status !== "sent") return true;
  if (!result.ok) return false;
  const payload = input.request.payload as Record<string, unknown>;
  if (input.prepared.channel === "napcat" && payload.type === "file") {
    if (!String(result.sentFileId ?? "").trim()) return false;
    if (String(payload.text ?? "").trim() && !String(result.sentMessageId ?? "").trim()) return false;
  }
  // Other channels may have richer authoritative receipts. This generic service
  // requires a platform identifier rather than inventing one from presence.
  return Boolean(String(result.sentMessageId || result.sentFileId || "").trim());
}

async function reconcileAgentSend(deliveryId: unknown, originalRequest: AgentSendRequest,
  options: AgentSendReconciliationOptions, settle: boolean): Promise<AgentSendReconciliationResponse> {
  // Invalid input throws before any receipt read or trusted callback.
  const input = prepareInput(deliveryId, originalRequest);
  const read = readSnapshot(options.rootDir, input.deliveryId);
  if (!read.snapshot) return read.failure!;
  const receipt = read.snapshot.receipt;
  if (receipt.requestDigest !== input.digest) {
    return response(input.deliveryId, 409, { state: "conflict", code: "DIGEST_CONFLICT" });
  }
  if (receipt.state === "completed" && settle) {
    if (!completeOriginalResult(receipt.result, input)) {
      return response(input.deliveryId, 409, { state: "conflict", code: "RECEIPT_CORRUPT" });
    }
    // Replay is NOT a new platform verification or a new commit.
    return response(input.deliveryId, 200, { state: "completed", originalResult: receipt.result });
  }
  let verification: AgentSendVerification | undefined;
  const verify = async (current: Readonly<DurableDeliveryReceipt<AgentSendResult>>) => {
    verification = await options.verify(structuredClone(input.request), structuredClone(current));
    if (verification?.platformVerification !== "present" || verification.originalTerminalProven !== true
      || !completeOriginalResult(verification.originalResult, input)) {
      return { state: "uncertain" as const, reason: "The entire original terminal delivery was not proven." };
    }
    return { state: "completed" as const, result: structuredClone(verification.originalResult) };
  };
  if (!settle) {
    try {
      await verify(receipt);
      if (!verification || !["present", "unknown"].includes(verification.platformVerification)) {
        return response(input.deliveryId, 503, { code: "VERIFICATION_UNAVAILABLE" });
      }
      return response(input.deliveryId, 200, {
        state: "verified", platformVerification: verification.platformVerification, evidence: verification.evidence,
        ...(verification.originalTerminalProven === true && completeOriginalResult(verification.originalResult, input)
          ? { originalResult: verification.originalResult } : {})
      });
    } catch {
      return response(input.deliveryId, 503, { code: "VERIFICATION_UNAVAILABLE" });
    }
  }
  let verificationUnavailable = false;
  const outcome = await reconcileDurableDelivery<AgentSendResult>({
    rootDir: options.rootDir, namespace: RECEIPT_NAMESPACE, deliveryId: input.deliveryId, payload: input.payload,
    verify: async current => {
      try { return await verify(current); }
      catch { verificationUnavailable = true; return { state: "uncertain", reason: "Verification unavailable." }; }
    }
  });
  const proof = {
    platformVerification: verification?.platformVerification === "present" ? "present" as const : "unknown" as const,
    ...(verification ? { evidence: verification.evidence } : {})
  };
  if (outcome.state === "completed") {
    // A concurrent completion wins unchanged. Only the durable owner reports
    // whether this invocation committed; result equality is not commit evidence.
    const proved = verification?.platformVerification === "present"
      && verification.originalTerminalProven === true && completeOriginalResult(verification.originalResult, input);
    if (!completeOriginalResult(outcome.result, input)) {
      return response(input.deliveryId, 503, { ...proof, settlement: "failed", code: "RECEIPT_PERSIST_FAILED" });
    }
    return response(input.deliveryId, 200, {
      ...(proved ? proof : {}), state: "completed", originalResult: outcome.result,
      settlement: outcome.settlement
    });
  }
  if (outcome.state === "in_progress") {
    return response(input.deliveryId, 409, { ...proof, state: "in_progress", code: "DELIVERY_ACTIVE" });
  }
  if (outcome.state === "conflict") {
    return response(input.deliveryId, 409, { ...proof, state: "conflict", code: "DIGEST_CONFLICT" });
  }
  if (verificationUnavailable) return response(input.deliveryId, 503, { code: "VERIFICATION_UNAVAILABLE" });
  const proved = verification?.platformVerification === "present"
    && verification.originalTerminalProven === true && completeOriginalResult(verification.originalResult, input);
  return response(input.deliveryId, proved ? 503 : 409, {
    ...proof, settlement: proved ? "failed" : "not_attempted",
    code: proved ? "RECEIPT_PERSIST_FAILED" : "ORIGINAL_TERMINAL_UNPROVEN"
  });
}

/** Read-only, including active receipts. No delivery, recovery, retry or mutation. */
export function verifyAgentSendDelivery(deliveryId: unknown, originalRequest: AgentSendRequest,
  options: AgentSendReconciliationOptions): Promise<AgentSendReconciliationResponse> {
  return reconcileAgentSend(deliveryId, originalRequest, options, false);
}

/** Internal controlled settlement. Route authentication/authorization belongs to
 * the future owning route; never expose the verifier as a public user function. */
export function settleAgentSendDelivery(deliveryId: unknown, originalRequest: AgentSendRequest,
  options: AgentSendReconciliationOptions): Promise<AgentSendReconciliationResponse> {
  return reconcileAgentSend(deliveryId, originalRequest, options, true);
}
