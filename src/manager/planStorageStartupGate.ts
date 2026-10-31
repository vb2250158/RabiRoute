import fs from "node:fs";
import path from "node:path";
import type { PlanLayoutMigrationResult } from "./planStorageStartupMigration.js";
import { capturePlanStoragePackageRecoveryConflicts } from "../planStoragePackageFence.js";

export type PlanStorageStartupGateSummary = {
  roles: number;
  migrated: number;
  reconciled: number;
  failures: string[];
  skipped: boolean;
  readyRoleIds?: string[];
  packageConflicts?: Array<{ roleId: string; planId: string; transactionPath: string; message: string }>;
};

export type PlanStorageStartupGateOptions = {
  rolesRoot: string;
  readOnly: boolean;
  roleDirectories?: readonly string[];
  recoverRoleLifecycle: (roleDir: string) => Promise<{
    results: unknown[];
    failures: Array<{ transactionPath: string; error: string; planId?: string }>;
  }>;
  migrateRole: (roleDir: string) => Promise<PlanLayoutMigrationResult>;
  recoverRoleFeedback: (roleDir: string) => Promise<{
    committed: number;
    alreadyCommitted: number;
    failures: Array<{ transactionPath: string; error: string; planId?: string }>;
  }>;
  recoverRolePackages: (roleDir: string) => Promise<{
    results: Array<{ status: "applied" | "unchanged" | "conflict"; planId: string; reason?: string; receiptPath?: string }>;
    errors: Array<{ receiptPath: string; message: string; planId?: string }>;
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
  const entries = options.roleDirectories ? [] : await readRoleDirectoryEntries(options.rolesRoot);
  const roleDirectories = options.roleDirectories ?? entries
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
    const packageSnapshot = capturePlanStoragePackageRecoveryConflicts(roleDir);
    if (packageSnapshot.unknown.length) {
      for (const conflict of packageSnapshot.unknown) summary.failures.push(`${path.basename(roleDir)}:${conflict.transactionPath}:package_recovery:${conflict.message}`);
      continue;
    }
    const fencedPlans = new Set(packageSnapshot.conflicts.map(conflict => conflict.planId!));
    const deferredPlans = new Set<string>();
    const roleFailureStart = summary.failures.length;
    const lifecycleRecovery = await options.recoverRoleLifecycle(roleDir);
    for (const failure of lifecycleRecovery.failures) {
      if (failure.planId && fencedPlans.has(failure.planId)) { deferredPlans.add(failure.planId); continue; }
      summary.failures.push(`${path.basename(roleDir)}:${failure.transactionPath}:lifecycle_recovery:${failure.error}`);
    }
    if (summary.failures.length > roleFailureStart) continue;
    const outcome = await options.migrateRole(roleDir);
    summary.migrated += outcome.migrated;
    summary.reconciled += outcome.reconciled;
    for (const failure of outcome.failures) {
      if (failure.packageRecoveryBlocked && fencedPlans.has(failure.planId)) { deferredPlans.add(failure.planId); continue; }
      summary.failures.push(`${path.basename(roleDir)}:${failure.planId}:${failure.error}`);
    }
    if (summary.failures.length > roleFailureStart) continue;
    const feedbackRecovery = await options.recoverRoleFeedback(roleDir);
    for (const failure of feedbackRecovery.failures) {
      if (failure.planId && fencedPlans.has(failure.planId)) { deferredPlans.add(failure.planId); continue; }
      summary.failures.push(`${path.basename(roleDir)}:${failure.transactionPath}:feedback_recovery:${failure.error}`);
    }
    if (summary.failures.length > roleFailureStart) continue;
    const recovery = await options.recoverRolePackages(roleDir);
    for (const result of recovery.results) {
      if (result.status !== "conflict") continue;
      (summary.packageConflicts ??= []).push({ roleId: path.basename(roleDir), planId: result.planId,
        transactionPath: result.receiptPath ?? "", message: result.reason || "conflict" });
    }
    for (const error of recovery.errors) {
      if (error.planId) {
        (summary.packageConflicts ??= []).push({ roleId: path.basename(roleDir), planId: error.planId,
          transactionPath: error.receiptPath, message: error.message });
        continue;
      }
      summary.failures.push(`${path.basename(roleDir)}:${error.receiptPath}:package_recovery:${error.message}`);
    }
    for (const planId of deferredPlans) {
      if (!summary.packageConflicts?.some(conflict => conflict.roleId === path.basename(roleDir) && conflict.planId === planId)) {
        summary.failures.push(`${path.basename(roleDir)}:${planId}:startup_followup_required_after_package_recovery`);
      }
    }
  }
  if (summary.failures.length > 0) throw new PlanStorageStartupGateError(summary);
  return summary;
}
