import { parentPort, workerData } from "node:worker_threads";
import { migrateRolePlanLayout } from "../roleKnowledge.js";

type WorkerInput = {
  roleDir?: unknown;
};

const input = workerData as WorkerInput;

try {
  if (!parentPort) throw new Error("role plan layout migration worker has no parent port");
  if (typeof input.roleDir !== "string" || input.roleDir.trim().length === 0) {
    throw new Error("role plan layout migration worker requires roleDir");
  }
  parentPort.postMessage({ ok: true, outcome: migrateRolePlanLayout(input.roleDir) });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  });
}
