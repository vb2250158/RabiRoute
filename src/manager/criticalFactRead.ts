import type { CriticalProjectFactRecordVerificationInput } from "../messageProcessing/criticalFactRecord.js";
import { managerKnowledgePageWorkerPool } from "./managerReadWorkerPool.js";

/** Physical evidence verification belongs in the bounded storage process. */
export async function verifyCriticalProjectFactRecordInWorker(input: CriticalProjectFactRecordVerificationInput): Promise<void> {
  if (!input.requirement?.criticalFacts?.length || !input.disposition || input.disposition.status === "not_applicable") return;
  const verified = await managerKnowledgePageWorkerPool.run<boolean>({ type: "critical_fact_record_verify", input });
  if (verified !== true) throw new Error("Critical project fact verification is unavailable; retry shortly.");
}
