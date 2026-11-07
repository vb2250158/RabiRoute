import type { CodexThreadCreateResult } from "./agentAdapters/codexContracts.js";
import { createCodexThreadWithReservation, readCallerCodexCreation } from "./codexThreadCreationReservations.js";
import type { CodexThreadCreationState } from "./codexThreadCreationReservations.js";
import { completeAgentSessionId } from "./agentRequests/requestValidation.js";

export type CallerCreationLookup =
  | { available: true; state: "absent" }
  | { available: true; state: Extract<CodexThreadCreationState, "thread_created" | "naming" | "initial_turn" | "completed">; intentHash: string; threadId: string }
  | { available: true; state: Exclude<CodexThreadCreationState, "thread_created" | "naming" | "initial_turn" | "completed">; intentHash: string; threadId?: string }
  | { available: false; errorCode: "CREATION_EVIDENCE_UNAVAILABLE" };

/** Safe metadata from the original exact caller key, without paths, prompts or native error text. */
export function readCallerCreationLookup(rootDir: string, callerKey: string): CallerCreationLookup {
  const reservation = readCallerCodexCreation(rootDir, callerKey);
  if (!reservation) return { available: true, state: "absent" };
  if (!/^[a-f0-9]{64}$/.test(reservation.callerIntentHash!)) throw new Error("Original creation digest is invalid.");
  if (reservation.state === "thread_created" || reservation.state === "naming" || reservation.state === "initial_turn" || reservation.state === "completed") {
    const threadId = completeAgentSessionId(reservation.threadId, "threadId");
    return { available: true, state: reservation.state, intentHash: reservation.callerIntentHash!, threadId };
  }
  return { available: true, state: reservation.state, intentHash: reservation.callerIntentHash!,
    ...(reservation.threadId !== undefined ? { threadId: completeAgentSessionId(reservation.threadId, "threadId") } : {}) };
}

export type CallerCreationMetadataStatus = {
  protocolVersion: 1;
  callerKey: string;
  state: "absent" | "reserved" | "creating" | "thread_created" | "naming" | "initial_turn" | "completed" | "uncertain" | "failed_before_create";
  intentHash?: string;
  threadId?: string;
  thread?: CodexThreadCreateResult;
};

/** Existing SDK management authority owns access; this key is idempotency data, never an identity grant. */
export function callerCreationMetadataStatus(rootDir: string, callerKey: string): CallerCreationMetadataStatus {
  const reservation = readCallerCodexCreation(rootDir, callerKey);
  return reservation ? { protocolVersion: 1, callerKey, intentHash: reservation.callerIntentHash,
    state: reservation.state, ...(reservation.threadId ? { threadId: reservation.threadId } : {}), ...(reservation.result ? { thread: reservation.result } : {}) }
    : { protocolVersion: 1, callerKey, state: "absent" };
}

/** Metadata only: native task creation receives no prompt and no asserted message source. */
export async function createCallerCreationMetadata(params: {
  rootDir: string; callerKey: string; intentHash: string; title: string; workspace: string;
  create: (onStage: (state: "thread_created" | "naming" | "initial_turn", threadId: string) => void) => Promise<CodexThreadCreateResult>;
}): Promise<CallerCreationMetadataStatus> {
  const thread = await createCodexThreadWithReservation({ rootDir: params.rootDir, title: params.title,
    workspace: params.workspace, callerIntent: { key: params.callerKey, hash: params.intentHash }, create: params.create });
  return { protocolVersion: 1, callerKey: params.callerKey, intentHash: params.intentHash, state: "completed", threadId: thread.id, thread };
}
