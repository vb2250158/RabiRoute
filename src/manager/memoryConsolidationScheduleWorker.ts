import {
  inspectMemoryConsolidationSchedule,
  memoryConsolidationRunRevision
} from "../roleKnowledge.js";

type ChildInput = {
  roleDir?: unknown;
};

type ChildResult =
  | Readonly<{
    ok: true;
    evaluation: {
      pending: { runId: string; delivered: boolean; revision: string } | null;
      dueOperationIdentity?: string;
      nextTriggerAt?: number;
    };
  }>
  | Readonly<{ ok: false }>;

function readInput(): ChildInput {
  const encoded = process.env.RABIROUTE_MEMORY_CONSOLIDATION_SCHEDULE_INPUT;
  if (!encoded) throw new Error("memory consolidation schedule child requires input");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ChildInput;
}

function sendResult(result: ChildResult): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== "function") {
      reject(new Error("memory consolidation schedule child has no IPC channel"));
      return;
    }
    process.send(result, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

try {
  const input = readInput();
  if (typeof input.roleDir !== "string" || input.roleDir.trim().length === 0) {
    throw new Error("memory consolidation schedule child requires roleDir");
  }

  const inspection = inspectMemoryConsolidationSchedule(input.roleDir);
  await sendResult({
    ok: true,
    evaluation: {
      pending: inspection.pending
        ? {
            runId: inspection.pending.run.id,
            delivered: Boolean(inspection.pending.run.deliveredAt),
            revision: memoryConsolidationRunRevision(inspection.pending.run)
          }
        : null,
      dueOperationIdentity: inspection.dueOperationIdentity,
      nextTriggerAt: inspection.nextTriggerAt
    }
  });
} catch {
  await sendResult({ ok: false }).catch(() => undefined);
} finally {
  if (process.connected) process.disconnect();
}
