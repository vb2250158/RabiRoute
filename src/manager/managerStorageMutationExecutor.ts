import {
  MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,
  sameManagerStorageMutationFence,
  type ManagerStorageMutationExecutorResolution,
  type ManagerStorageMutationRequest
} from "./managerStorageMutationProtocol.js";
import type { PlanUpdateExecutorDescriptor, PlanUpdateExecutorPin } from "./planUpdateExecutor.js";
import { parsePlanUpdateExecutorPin, samePlanUpdateExecutorPin } from "./planUpdateExecutor.js";

/** The existing pool deadline/abort terminates this request's child and removes this waiter. */
export function resolveStorageMutationExecutor(
  request: ManagerStorageMutationRequest,
  pin: PlanUpdateExecutorPin
): Promise<PlanUpdateExecutorDescriptor> {
  if (request.planUpdateExecutor && samePlanUpdateExecutorPin(request.planUpdateExecutor.pin, pin)) {
    return Promise.resolve(request.planUpdateExecutor);
  }
  if (!process.connected || !process.send) return Promise.reject(new Error("The original plan executor cannot be resolved without its parent."));
  const query: ManagerStorageMutationExecutorResolution = {
    protocolVersion: MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,
    requestId: request.requestId,
    fence: request.fence,
    admissionNonce: request.admissionNonce,
    stage: "executor_resolution",
    sequence: 1,
    kind: "executor_resolution_request",
    pin
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (executor?: PlanUpdateExecutorDescriptor) => {
      if (settled) return;
      settled = true;
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      if (executor) resolve(executor);
      else reject(new Error("The original plan executor package could not be restored."));
    };
    const onDisconnect = () => finish();
    const onMessage = (raw: unknown) => {
      const decision = raw as Partial<ManagerStorageMutationExecutorResolution> | null;
      if (!decision || decision.kind !== "executor_resolution_decision" || decision.requestId !== query.requestId) return;
      try {
        if (decision.protocolVersion !== query.protocolVersion || decision.admissionNonce !== query.admissionNonce
          || decision.stage !== query.stage || decision.sequence !== query.sequence || !decision.fence
          || !sameManagerStorageMutationFence(decision.fence, query.fence) || decision.allowed !== true) {
          finish();
          return;
        }
        const selected = decision.executor;
        if (!selected || typeof selected.entryUrl !== "string"
          || !samePlanUpdateExecutorPin(parsePlanUpdateExecutorPin(selected.pin), pin)) {
          finish();
          return;
        }
        finish(selected);
      } catch { finish(); }
    };
    process.on("message", onMessage);
    process.on("disconnect", onDisconnect);
    try { process.send!(query, error => { if (error) finish(); }); }
    catch { finish(); }
  });
}
