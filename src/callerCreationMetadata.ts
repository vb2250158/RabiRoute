import type { CodexThreadCreateResult } from "./agentAdapters/codexContracts.js";
import { createCodexThreadWithReservation, readCallerCodexCreation } from "./codexThreadCreationReservations.js";

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
