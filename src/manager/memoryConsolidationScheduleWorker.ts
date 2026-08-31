import { parentPort, workerData } from "node:worker_threads";
import {
  nextMemoryConsolidationTriggerAt,
  pendingMemoryConsolidation
} from "../roleKnowledge.js";

type WorkerInput = {
  roleDir?: unknown;
};

const input = workerData as WorkerInput;

try {
  if (!parentPort) throw new Error("memory consolidation schedule worker has no parent port");
  if (typeof input.roleDir !== "string" || input.roleDir.trim().length === 0) {
    throw new Error("memory consolidation schedule worker requires roleDir");
  }

  const request = pendingMemoryConsolidation(input.roleDir, "auto");
  parentPort.postMessage({
    ok: true,
    evaluation: {
      pending: request
        ? { runId: request.run.id, delivered: Boolean(request.run.deliveredAt) }
        : null,
      nextTriggerAt: nextMemoryConsolidationTriggerAt(input.roleDir)
    }
  });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  });
}
