import { prepareAgentSendRequest, type AgentSendDeliveryInspection, type AgentSendRequest } from "../agentSend.js";
import type { OriginalQqFileBinding, QqFileVerificationResult } from "./agentDeliveryVerification.js";
import type { AgentSendReconciliationOptions, AgentSendVerification } from "./agentSendReconciliation.js";
import { durableDeliveryRequestDigest, normalizeDurableDeliveryId } from "./durableDeliveryIdempotency.js";

/** Trusted history owner must bind the observation to the ORIGINAL outer request
 * digest (not Outbox's internal request digest). A bare inspection is insufficient:
 * older Outbox readers can conceal conflicting records behind a terminal record. */
export type AgentSendHistoryEvidence = Readonly<{
  deliveryId: string;
  requestDigest: string;
  historyConflict: boolean;
  inspection: AgentSendDeliveryInspection;
  /** Owner checked the entire terminal operation, including secondary messages. */
  terminalComplete?: true;
}>;

export type AgentSendOriginalBindingEvidence = Readonly<{
  deliveryId: string;
  requestDigest: string;
  binding: OriginalQqFileBinding;
}>;

/** Internal capabilities only. Never construct dependencies from HTTP JSON.
 * No send, recover, retry, receipt write, generic transport or current-account
 * fallback is accepted. Missing original selfId/revision intentionally stays unknown. */
export type AgentSendVerificationEvidenceDependencies = Readonly<{
  inspect: (request: Readonly<AgentSendRequest>, requestDigest: string) => Promise<AgentSendHistoryEvidence>;
  getOriginalBinding?: (request: Readonly<AgentSendRequest>, history: Readonly<AgentSendHistoryEvidence>)
    => Promise<AgentSendOriginalBindingEvidence | undefined>;
  verifyCurrentPresence?: (binding: OriginalQqFileBinding) => Promise<QqFileVerificationResult>;
}>;

type EvidenceReason = "invalid_request" | "receipt_conflict" | "history_conflict" | "history_unavailable"
  | "terminal_unproven" | "unsupported_channel" | "binding_unavailable" | "binding_conflict" | "platform_unknown" | "exact_file_id" | "read_failed";

function observation(reason: EvidenceReason, historicalTerminalProven = false): AgentSendVerification {
  return { platformVerification: "unknown", evidence: { reason, historicalTerminalProven,
    deliveredNow: false, retryAllowed: false, sha256Verified: false, captionVerified: false } };
}

/** Produces exactly AgentSendReconciliationOptions['verify']; performs observations
 * only. Historical completion is independent of present-day file existence. */
export function createAgentSendVerificationEvidenceVerifier(
  dependencies: AgentSendVerificationEvidenceDependencies
): AgentSendReconciliationOptions["verify"] {
  // Capture capabilities once; later mutation of the dependency container cannot replace them.
  const { inspect, getOriginalBinding, verifyCurrentPresence } = dependencies;
  return async (originalRequest, originalReceipt) => {
    try {
      const request = structuredClone(originalRequest);
      const receipt = structuredClone(originalReceipt);
      let prepared: ReturnType<typeof prepareAgentSendRequest>;
      let deliveryId: string;
      let requestDigest: string;
      try {
        deliveryId = normalizeDurableDeliveryId(request.deliveryId);
        prepared = prepareAgentSendRequest(request);
        const { deliveryId: _id, ...payload } = request;
        requestDigest = durableDeliveryRequestDigest(payload);
      } catch { return observation("invalid_request"); }
      if (receipt.deliveryId !== deliveryId || receipt.requestDigest !== requestDigest) return observation("receipt_conflict");
      const history = structuredClone(await inspect(structuredClone(request), requestDigest));
      if (!history || history.deliveryId !== deliveryId || history.requestDigest !== requestDigest
        || history.historyConflict !== false) return observation("history_conflict");
      if (history.inspection?.state !== "completed") return observation("history_unavailable");
      const result = history.inspection.result;
      const equal = (left: unknown, right: unknown) => durableDeliveryRequestDigest(JSON.parse(JSON.stringify(left ?? null)))
        === durableDeliveryRequestDigest(JSON.parse(JSON.stringify(right ?? null)));
      if (!result || result.deliveryId !== deliveryId || result.channel !== prepared.channel || result.routeId !== prepared.routeId
        || !equal(result.sender, prepared.sender) || !equal(result.target, prepared.target)
        || result.status !== "sent" || result.ok !== true) return observation("terminal_unproven");
      if (receipt.result && !equal(receipt.result, result)) return observation("history_conflict");
      const payload = request.payload as Record<string, unknown>;
      if (prepared.channel !== "napcat" || payload.type !== "file" || prepared.target.target !== "group") return observation("unsupported_channel");
      const hasId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
      if (!hasId(result.sentFileId)) return observation("terminal_unproven");
      const historicalTerminalProven = history.terminalComplete === true
        && (!String(payload.text ?? "").trim() || hasId(result.sentMessageId));
      const proof = getOriginalBinding ? structuredClone(await getOriginalBinding(structuredClone(request), structuredClone(history))) : undefined;
      if (!proof || !verifyCurrentPresence) return observation("binding_unavailable", historicalTerminalProven);
      const binding = proof.binding;
      if (proof.deliveryId !== deliveryId || proof.requestDigest !== requestDigest || !binding
        || binding.routeId !== prepared.routeId || binding.groupId !== prepared.target.groupId
        || binding.instanceId !== result.instanceId || binding.platformFileId !== result.sentFileId
        || !hasId(binding.selfId) || !hasId(binding.bindingRevision)) return observation("binding_conflict", historicalTerminalProven);
      const current = await verifyCurrentPresence(Object.freeze({ ...binding }));
      if (current?.status !== "present" || current.reason !== "exact_file_id" || current.deliveredNow !== false
        || current.retryAllowed !== false || current.sha256Verified !== false || current.captionVerified !== false) {
        return observation("platform_unknown", historicalTerminalProven);
      }
      const verified = observation("exact_file_id", historicalTerminalProven);
      verified.platformVerification = "present";
      // Never synthesize a result or caption from platform presence.
      if (historicalTerminalProven) {
        verified.originalTerminalProven = true;
        verified.originalResult = structuredClone(result);
      }
      return verified;
    } catch {
      // Dependency errors can contain credentials, platform bodies and local paths.
      return observation("read_failed");
    }
  };
}
