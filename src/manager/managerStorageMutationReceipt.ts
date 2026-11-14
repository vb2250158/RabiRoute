import path from "node:path";
import {
  inspectPlanStorageMutationReceiptUnderLease,
  withPlanStorageLeaseAsync,
  assertPlanStorageLeaseOwner
} from "../planStorageRepository.js";
import {
  reconcileDurableDelivery,
  receiptExecutionOwnerGone,
  type DurableDeliveryReceipt
} from "./durableDeliveryIdempotency.js";
import {
  MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,
  type ManagerStorageMutationRequest,
  type ManagerStorageMutationReceiptResult
} from "./managerStorageMutationProtocol.js";

type ReceiptDomainResult =
  | { domain: "committed"; value: unknown }
  | {
      domain: "rejected";
      error: string;
      commitState?: "not_committed";
      stage?: "precommit_staging";
      retryable?: false;
    };

function terminalResult(
  result: unknown,
  settlement: "committed" | "not_attempted"
): ManagerStorageMutationReceiptResult {
  const envelope = result && typeof result === "object" ? result as ReceiptDomainResult : undefined;
  if (envelope?.domain === "rejected") {
    return {
      state: "completed",
      operationState: "failed",
      commitState: "not_committed",
      reason: envelope.error,
      reasonCode: envelope.error.startsWith("STORAGE_MUTATION_ABORTED_BEFORE_COMMIT:")
        ? "STORAGE_MUTATION_ABORTED_BEFORE_COMMIT"
        : "STORAGE_MUTATION_REJECTED",
      retryable: false,
      ...(envelope.stage ? { stage: envelope.stage } : {}),
      settlement
    };
  }
  return {
    state: "completed",
    operationState: "succeeded",
    commitState: "committed",
    value: envelope?.domain === "committed" ? envelope.value : result,
    settlement
  };
}

/** Reconcile the original ledger entry while its original domain lease is held. */
export async function reconcileManagerStorageMutationReceipt(
  request: ManagerStorageMutationRequest,
  roleDir: string
): Promise<ManagerStorageMutationReceiptResult> {
  if (request.mode !== "receipt_only" || request.task.type !== "plan_update" || !request.fence.planId) {
    throw new TypeError("Receipt-only reconciliation requires an original plan update.");
  }
  const payload = {
    roleId: request.fence.roleId,
    planId: request.fence.planId,
    task: request.task,
    ...(request.actor ? { actor: request.actor } : {})
  };
  return withPlanStorageLeaseAsync(roleDir, request.fence.planId, async lease => {
    const outcome = await reconcileDurableDelivery<ReceiptDomainResult>({
      rootDir: path.join(roleDir, "runtime"),
      namespace: MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,
      deliveryId: request.requestId,
      payload,
      requestAuthority: () => assertPlanStorageLeaseOwner(lease),
      verify: async (receipt: Readonly<DurableDeliveryReceipt<ReceiptDomainResult>>) => {
        const audit = receipt.audit as { expectedRevision?: unknown } | undefined;
        const recordedRevision = audit?.expectedRevision;
        const expected = typeof recordedRevision === "string"
          ? recordedRevision.match(/^inventory-sha256:([a-f0-9]{64})$/)?.[1]
          : undefined;
        const proof = inspectPlanStorageMutationReceiptUnderLease(lease, {
          requestId: request.requestId,
          expectedInventoryHash: expected ?? ""
        });
        // Matching durable commit evidence is independent of a precommit version anchor.
        if (proof.state === "committed") {
          return { state: "completed", result: { domain: "committed", value: proof.value } };
        }
        if (proof.state === "unknown") return { state: "uncertain", reason: proof.reason };
        if (request.expectedRevision !== null && request.expectedRevision !== recordedRevision) {
          return { state: "uncertain", reason: "The supplied expected revision differs from the original durable audit." };
        }
        if (!receiptExecutionOwnerGone(receipt)) {
          return {
            state: "uncertain",
            reason: "The original execution owner has not been confirmed retired. Receipt expiry alone cannot prove it stopped."
          };
        }
        return {
          state: "completed",
          result: {
            domain: "rejected",
            error: "STORAGE_MUTATION_ABORTED_BEFORE_COMMIT: The original execution ended during precommit staging. No plan mutation was committed.",
            commitState: "not_committed",
            stage: "precommit_staging",
            retryable: false
          }
        };
      }
    });
    if (outcome.state === "completed") return terminalResult(outcome.result, outcome.settlement);
    return {
      state: outcome.state,
      operationState: outcome.state === "uncertain" ? "unknown" : outcome.state,
      commitState: "unknown",
      reason: outcome.reason
    };
  });
}
