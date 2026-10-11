import {
  MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,
  sameManagerStorageMutationFence,
  type ManagerStorageMutationAdmission,
  type ManagerStorageMutationRequest
} from "./managerStorageMutationProtocol.js";

export class StorageMutationAdmissionError extends Error {
  readonly code = "authorization_revoked" as const;
  constructor() {
    super("Original request commit admission was denied.");
    this.name = "StorageMutationAdmissionError";
  }
}

type AdmissionTransport = {
  readonly connected?: boolean;
  on(event: "message" | "disconnect", listener: (...args: any[]) => void): unknown;
  off(event: "message" | "disconnect", listener: (...args: any[]) => void): unknown;
  send?: (message: unknown, callback: (error: Error | null) => void) => unknown;
};

/**
 * Runs before receipt lookup/reservation, WAL recovery or domain access. A matching
 * allow is irreversible admission for this complete operation, not a revocable
 * lease. The parent owns the request deadline and terminates a waiting worker on
 * timeout/abort. Never await this handshake inside a synchronous file lock.
 */
export async function acquireStorageMutationCommitAdmission(
  request: ManagerStorageMutationRequest,
  transport: AdmissionTransport
): Promise<void> {
  if (request.admissionNonce === undefined) return;
  if (!transport.connected || !transport.send) throw new StorageMutationAdmissionError();
  const admission: ManagerStorageMutationAdmission = {
    protocolVersion: MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,
    requestId: request.requestId,
    fence: request.fence,
    admissionNonce: request.admissionNonce,
    kind: "authorization_request",
    stage: "commit_admission",
    sequence: 1
  };
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (allowed: boolean) => {
      if (settled) return;
      settled = true;
      transport.off("message", onMessage);
      transport.off("disconnect", onDisconnect);
      if (allowed) resolve();
      else reject(new StorageMutationAdmissionError());
    };
    const onDisconnect = () => finish(false);
    const onMessage = (raw: unknown) => {
      const decision = raw as Partial<ManagerStorageMutationAdmission> | null;
      // While awaiting admission, any other envelope is a protocol violation.
      finish(Boolean(decision
        && decision.kind === "authorization_decision"
        && decision.protocolVersion === admission.protocolVersion
        && decision.requestId === admission.requestId
        && decision.admissionNonce === admission.admissionNonce
        && decision.stage === admission.stage
        && decision.sequence === admission.sequence
        && decision.fence
        && sameManagerStorageMutationFence(decision.fence, admission.fence)
        && decision.allowed === true));
    };
    transport.on("message", onMessage);
    transport.on("disconnect", onDisconnect);
    try { transport.send!(admission, error => { if (error) finish(false); }); }
    catch { finish(false); }
  });
}
