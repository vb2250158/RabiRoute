import fs from "node:fs";
import path from "node:path";
import {
  listPlanFeedbackAsync,
  listPlanFeedbackFiles,
  planFeedbackResponseId,
  updatePlanFeedbackDeliveryAsync,
  type PlanFeedbackRecord
} from "../planFeedback.js";
import { getPlanAsync, type PlanItem } from "../roleKnowledge.js";

export type PlanFeedbackRecoveryCandidate = {
  roleDir: string;
  roleId: string;
  plan: PlanItem;
  feedback: PlanFeedbackRecord;
};

export type PlanFeedbackDeliveryInspection = "accepted" | "in_progress" | "missing";

export type PlanFeedbackRecoveryTaskRequest = {
  threadId: string;
  cwd: string;
  deliveryId: string;
};

export type PlanFeedbackRecoveryOutcome =
  | { state: "delivered"; record: PlanFeedbackRecord }
  | { state: "scheduled" }
  | { state: "deferred"; reason: string }
  | { state: "failed"; error: unknown };

function isRecoverableFeedback(record: PlanFeedbackRecord): boolean {
  return (record.deliveryStatus === "pending" || record.deliveryStatus === "failed")
    && (record.kind === "guidance" || record.kind === "approval_suggestion")
    && record.author !== "agent"
    && !record.qaHandling;
}

const RECOVERY_DISCOVERY_CONCURRENCY = 24;
const RECOVERY_PLAN_READ_CONCURRENCY = 8;

type RoleFeedbackCatalog = {
  roleId: string;
  roleDir: string;
  files: string[];
};

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function readDirectories(directory: string, signal?: AbortSignal): Promise<fs.Dirent[]> {
  throwIfAborted(signal);
  try {
    return await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function mapBounded<T, U>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<U>,
  signal?: AbortSignal
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, values.length)) },
    async () => {
      while (true) {
        throwIfAborted(signal);
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await map(values[index]!);
      }
    }
  ));
  return results;
}

async function discoverRoleFeedbackCatalog(
  rolesRoot: string,
  roleEntry: fs.Dirent,
  signal?: AbortSignal
): Promise<RoleFeedbackCatalog> {
  const roleId = roleEntry.name;
  const roleDir = path.join(rolesRoot, roleId);
  const planDirectories = (
    await Promise.all((["active", "archive"] as const).map(async (bucket) => {
      const bucketDir = path.join(roleDir, "plans", bucket);
      const entries = await readDirectories(bucketDir, signal);
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(bucketDir, entry.name));
    }))
  ).flat();
  const discovered = await mapBounded(
    planDirectories,
    RECOVERY_DISCOVERY_CONCURRENCY,
    async (planDir) => {
      const feedbackFile = path.join(planDir, "feedback.jsonl");
      try {
        await fs.promises.access(feedbackFile, fs.constants.R_OK);
        return feedbackFile;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    signal
  );
  const legacyDir = path.join(roleDir, "plans", "feedback");
  const legacyFiles = (await readDirectories(legacyDir, signal))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl"))
    .map((entry) => path.join(legacyDir, entry.name));
  return {
    roleId,
    roleDir,
    files: [...discovered.filter((filePath): filePath is string => Boolean(filePath)), ...legacyFiles]
  };
}

export async function listOpenPlanFeedbackRecoveryCandidates(
  rolesRoot: string,
  signal?: AbortSignal
): Promise<PlanFeedbackRecoveryCandidate[]> {
  throwIfAborted(signal);
  let roleEntries: fs.Dirent[];
  try {
    roleEntries = (await fs.promises.readdir(rolesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const catalogs = await mapBounded(
    roleEntries,
    4,
    (entry) => discoverRoleFeedbackCatalog(rolesRoot, entry, signal),
    signal
  );
  const candidates: PlanFeedbackRecoveryCandidate[] = [];
  for (const catalog of catalogs) {
    throwIfAborted(signal);
    const feedbackRows = await listPlanFeedbackFiles(catalog.files, signal);
    const recoverableFeedback = feedbackRows.filter(isRecoverableFeedback);
    const planIds = [...new Set(recoverableFeedback.map(feedback => feedback.planId))];
    const planEntries = await mapBounded(
      planIds,
      RECOVERY_PLAN_READ_CONCURRENCY,
      async (planId) => [
        planId,
        await getPlanAsync(catalog.roleDir, planId, { signal })
      ] as const,
      signal
    );
    const plans = new Map<string, PlanItem | null>(planEntries);
    for (const feedback of recoverableFeedback) {
      const plan = plans.get(feedback.planId);
      if (plan) candidates.push({
        roleDir: catalog.roleDir,
        roleId: catalog.roleId,
        plan,
        feedback
      });
    }
  }
  return candidates.sort((left, right) => {
    const createdDelta = Date.parse(left.feedback.createdAt) - Date.parse(right.feedback.createdAt);
    return createdDelta || left.feedback.id.localeCompare(right.feedback.id);
  });
}

export async function recoverPlanFeedbackCandidate(
  candidate: PlanFeedbackRecoveryCandidate,
  options: {
    signal?: AbortSignal;
    inspect: (request: PlanFeedbackRecoveryTaskRequest) => Promise<PlanFeedbackDeliveryInspection>;
    schedule: (candidate: PlanFeedbackRecoveryCandidate) => Promise<void>;
  }
): Promise<PlanFeedbackRecoveryOutcome> {
  options.signal?.throwIfAborted();
  const responseKind = candidate.feedback.kind === "guidance"
    ? "guidance_response"
    : "approval_response";
  const currentFeedback = await listPlanFeedbackAsync(candidate.roleDir, candidate.plan.id, options.signal);
  const latestCandidate = currentFeedback.find(record => record.id === candidate.feedback.id);
  if (!latestCandidate || !isRecoverableFeedback(latestCandidate)) {
    return latestCandidate?.deliveryStatus === "delivered"
      ? { state: "delivered", record: latestCandidate }
      : { state: "deferred", reason: "Feedback is no longer recoverable in the authoritative ledger." };
  }
  const currentCandidate: PlanFeedbackRecoveryCandidate = {
    ...candidate,
    feedback: latestCandidate
  };
  const linkedResponse = currentFeedback.find((record) => (
    record.id === planFeedbackResponseId(candidate.feedback)
    && record.kind === responseKind
    && record.author === "agent"
  ));
  if (linkedResponse) {
    return {
      state: "delivered",
      record: await updatePlanFeedbackDeliveryAsync(
        candidate.roleDir,
        latestCandidate,
        "delivered",
        `Manager recovery confirmed linked ${responseKind} ${linkedResponse.id}.`,
        options.signal
      )
    };
  }

  const binding = candidate.plan.taskBinding;
  if (!binding?.sessionId?.trim() || !binding.workspace?.trim()) {
    await options.schedule(currentCandidate);
    return { state: "scheduled" };
  }

  let state: PlanFeedbackDeliveryInspection;
  try {
    state = await options.inspect({
      threadId: binding.sessionId.trim(),
      cwd: binding.workspace.trim(),
      deliveryId: candidate.feedback.id
    });
  } catch (error) {
    return {
      state: "failed",
      error
    };
  }

  if (state === "accepted") {
    return {
      state: "delivered",
      record: await updatePlanFeedbackDeliveryAsync(
        candidate.roleDir,
        latestCandidate,
        "delivered",
        "Manager recovery confirmed the feedback in the bound Desktop task.",
        options.signal
      )
    };
  }
  if (state === "in_progress") {
    return {
      state: "deferred",
      reason: "The bound Desktop task is active; wait for an authoritative delivery readback."
    };
  }

  await options.schedule(currentCandidate);
  return { state: "scheduled" };
}
