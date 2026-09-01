import fs from "node:fs";
import path from "node:path";
import type { PlanLayoutMigrationResult } from "./planStorageStartupMigration.js";

export type PlanStorageStartupGateSummary = {
  roles: number;
  migrated: number;
  reconciled: number;
  failures: string[];
  skipped: boolean;
};

export type PlanStorageStartupGateOptions = {
  rolesRoot: string;
  readOnly: boolean;
  recoverRoleLifecycle: (roleDir: string) => Promise<{
    results: unknown[];
    failures: Array<{ transactionPath: string; error: string }>;
  }>;
  migrateRole: (roleDir: string) => Promise<PlanLayoutMigrationResult>;
  recoverRoleFeedback: (roleDir: string) => Promise<{
    committed: number;
    alreadyCommitted: number;
    failures: Array<{ transactionPath: string; error: string }>;
  }>;
  recoverRolePackages: (roleDir: string) => Promise<{
    results: Array<{ status: "applied" | "unchanged" | "conflict"; planId: string; reason?: string }>;
    errors: Array<{ receiptPath: string; message: string }>;
  }>;
  yieldControl?: () => Promise<void>;
};

export class PlanStorageStartupGateError extends Error {
  constructor(readonly summary: PlanStorageStartupGateSummary) {
    super(`Plan storage startup gate rejected ${summary.failures.length} unresolved conflict(s): ${summary.failures.slice(0, 10).join(" | ")}`);
    this.name = "PlanStorageStartupGateError";
  }
}

async function readRoleDirectoryEntries(rolesRoot: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(rolesRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function runPlanStorageStartupGate(
  options: PlanStorageStartupGateOptions
): Promise<PlanStorageStartupGateSummary> {
  if (options.readOnly) {
    return { roles: 0, migrated: 0, reconciled: 0, failures: [], skipped: true };
  }
  const entries = await readRoleDirectoryEntries(options.rolesRoot);
  const roleDirectories = entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => path.join(options.rolesRoot, entry.name))
    .sort((left, right) => left.localeCompare(right));
  const summary: PlanStorageStartupGateSummary = {
    roles: roleDirectories.length,
    migrated: 0,
    reconciled: 0,
    failures: [],
    skipped: false
  };
  for (const roleDir of roleDirectories) {
    await (options.yieldControl?.() ?? new Promise<void>(resolve => setImmediate(resolve)));
    const lifecycleRecovery = await options.recoverRoleLifecycle(roleDir);
    for (const failure of lifecycleRecovery.failures) {
      summary.failures.push(`${path.basename(roleDir)}:${failure.transactionPath}:lifecycle_recovery:${failure.error}`);
    }
    if (lifecycleRecovery.failures.length > 0) continue;
    const outcome = await options.migrateRole(roleDir);
    summary.migrated += outcome.migrated;
    summary.reconciled += outcome.reconciled;
    for (const failure of outcome.failures) {
      summary.failures.push(`${path.basename(roleDir)}:${failure.planId}:${failure.error}`);
    }
    if (outcome.failures.length > 0) continue;
    const feedbackRecovery = await options.recoverRoleFeedback(roleDir);
    for (const failure of feedbackRecovery.failures) {
      summary.failures.push(`${path.basename(roleDir)}:${failure.transactionPath}:feedback_recovery:${failure.error}`);
    }
    if (feedbackRecovery.failures.length > 0) continue;
    const recovery = await options.recoverRolePackages(roleDir);
    for (const result of recovery.results) {
      if (result.status !== "conflict") continue;
      summary.failures.push(`${path.basename(roleDir)}:${result.planId}:package_recovery:${result.reason || "conflict"}`);
    }
    for (const error of recovery.errors) {
      summary.failures.push(`${path.basename(roleDir)}:${error.receiptPath}:package_recovery:${error.message}`);
    }
  }
  if (summary.failures.length > 0) throw new PlanStorageStartupGateError(summary);
  return summary;
}
