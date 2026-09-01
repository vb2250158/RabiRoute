import fs from "node:fs";
import path from "node:path";
import {
  listPlanFeedbackFiles,
  type PlanFeedbackRecord
} from "../planFeedback.js";
import { getPlanAsync, type PlanItem } from "../roleKnowledge.js";
import {
  isRecoverablePlanFeedback,
  type PlanFeedbackRecoveryCandidate
} from "./planFeedbackRecovery.js";

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
    const feedbackRows: PlanFeedbackRecord[] = await listPlanFeedbackFiles(catalog.files, signal);
    const recoverableFeedback = feedbackRows.filter(isRecoverablePlanFeedback);
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
