import { RABI_CONTEXT_TRIGGER_POLICIES } from "../context/rabiContextManager.js";
import { roleStorageFailure } from "../roleLifecycle.js";
import { getTimeoutMs } from "../shared/timeoutSettings.js";
import type { CodexHookContextReadReply, CodexHookContextReadRequest, CodexHookContextWorkerReply,
  CodexHookKnowledgeBatchItem, CodexHookRoleStorageFailure } from "./codexHookContextRead.js";
import { managerHookContextWorkerPool, managerHookRoleWorkerPool, managerKnowledgePageWorkerPool } from "./managerReadWorkerPool.js";

type KnowledgeRead = Extract<CodexHookContextReadRequest, { kind: "knowledge" }>;
type PendingKnowledge = {
  trigger: KnowledgeRead["trigger"];
  resolve: (reply: CodexHookContextReadReply) => void;
  reject: (error: unknown) => void;
};
const knowledgeBatches = new Map<string, PendingKnowledge[]>();
const MAX_HOOK_KNOWLEDGE_BATCH = 64;

export async function readCodexHookContextWithWorkers(input: CodexHookContextReadRequest): Promise<CodexHookContextReadReply> {
  const timeoutMs = getTimeoutMs("agent.codex.hookRead", Number(process.env.RABIROUTE_CODEX_HOOK_READ_TIMEOUT_MS) || 45_000);
  const options = { timeoutMs, signal: AbortSignal.timeout(timeoutMs) };
  if (input.kind === "role_source") {
    const reply = await managerHookRoleWorkerPool.queryHookRoleSource(input, options);
    if (reply.kind === "role_storage_failure") throw roleStorageFailure(reply.code);
    return reply;
  }

  if (input.trigger.consolidationInputMemoryIds === undefined) return queueKnowledge(input.trigger, options);

  const reply = await managerHookContextWorkerPool.run<CodexHookContextWorkerReply>({ type: "codex_hook_context_read", input }, options);
  if (reply.kind === "role_storage_failure") throw roleStorageFailure(reply.code);
  return reply;
}

function queueKnowledge(trigger: PendingKnowledge["trigger"], options: { signal: AbortSignal; timeoutMs: number }): Promise<CodexHookContextReadReply> {
  const archive = RABI_CONTEXT_TRIGGER_POLICIES[trigger.kind].archiveCompletedPlans;
  const key = JSON.stringify([trigger.roleDir, archive]);
  const pending = knowledgeBatches.get(key);
  if (pending && pending.length < MAX_HOOK_KNOWLEDGE_BATCH) {
    return new Promise((resolve, reject) => pending.push({ trigger, resolve, reject }));
  }
  const batch: PendingKnowledge[] = [];
  knowledgeBatches.set(key, batch);
  const reply = new Promise<CodexHookContextReadReply>((resolve, reject) => batch.push({ trigger, resolve, reject }));
  void resolveKnowledgeBatch(key, batch, trigger.roleDir, archive, options);
  return reply;
}

async function resolveKnowledgeBatch(key: string, pending: PendingKnowledge[], roleDir: string, archive: boolean,
  options: { signal: AbortSignal; timeoutMs: number }): Promise<void> {
  try {
    const [memories, initialPlans] = await Promise.all([
      managerKnowledgePageWorkerPool.queryRoleMemoryCatalogs(roleDir, options),
      managerHookContextWorkerPool.queryHookPlanCatalog(roleDir, false, options)
    ]);
    if ("kind" in initialPlans) throw roleStorageFailure(initialPlans.code);
    const plans = archive && initialPlans.archiveDue
      ? await managerHookContextWorkerPool.queryHookPlanCatalog(roleDir, true, options)
      : initialPlans;
    if ("kind" in plans) throw roleStorageFailure(plans.code);
    if (knowledgeBatches.get(key) === pending) knowledgeBatches.delete(key);
    const batch = { memories, plans, triggers: pending.map(item => item.trigger) };
    const reply = await managerHookContextWorkerPool.run<CodexHookKnowledgeBatchItem[] | CodexHookRoleStorageFailure>(
      { type: "codex_hook_knowledge_batch", batch }, options);
    if (!Array.isArray(reply)) throw roleStorageFailure(reply.code);
    if (reply.length !== pending.length) throw new Error("Incomplete Hook knowledge batch reply.");
    for (const [index, item] of pending.entries()) {
      const row = reply[index];
      if ("result" in row) item.resolve(row.result);
      else item.reject(new Error(row.error));
    }
  } catch (error) {
    if (knowledgeBatches.get(key) === pending) knowledgeBatches.delete(key);
    for (const item of pending) item.reject(error);
  }
}
