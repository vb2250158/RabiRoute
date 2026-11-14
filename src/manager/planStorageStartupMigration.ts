import {
  clearPlanCatalogAfterStartupMigration,
  migratePersonaPlanStatusesAtStartup,
  normalizePlanForStartupMigration
} from "../roleKnowledge.js";
import { ensurePersonaPlanWorkflow } from "../personaPlanWorkflow.js";
import {
  migrateRolePlanLayout,
  type PlanLayoutMigrationResult
} from "../planStorageMigration.js";
import { recoverPlanStorageLegacyResolutions } from "../planStorageRepository.js";
import { canonicalizeRolePlanStorageDirectories } from "../planStorageReconciliation.js";

/** Complete original prepared transactions without starting a new layout/version upgrade. */
export function recoverPlanLayoutTransactions(roleDir: string): PlanLayoutMigrationResult {
  const legacy = recoverPlanStorageLegacyResolutions(roleDir);
  const names = canonicalizeRolePlanStorageDirectories(roleDir, { recoveryOnly: true });
  return { migrated: 0, skipped: 0, reconciled: legacy.results.length + names.recovered, alreadyReconciled: 0,
    receipts: [...legacy.results.map(item => item.receiptPath), ...names.receipts],
    failures: [...legacy.failures.map(item => ({ planId: item.planId ?? "*:legacy-resolution", error: item.error })), ...names.failures] };
}

export type { PlanLayoutMigrationResult } from "../planStorageMigration.js";

/**
 * The only production adapter allowed to invoke retired-layout migration.
 * This module is imported exclusively by the PlanStorageStartupLifecycle child.
 */
export function migrateRolePlanLayoutAtStartup(roleDir: string): PlanLayoutMigrationResult {
  ensurePersonaPlanWorkflow(roleDir);
  const result = migrateRolePlanLayout(roleDir, {
    normalizePlan: normalizePlanForStartupMigration,
    onChanged: () => clearPlanCatalogAfterStartupMigration(roleDir)
  });
  if (result.failures.length > 0) return result;
  const statuses = migratePersonaPlanStatusesAtStartup(roleDir);
  result.migrated += statuses.migrated;
  result.failures.push(...statuses.failures);
  return result;
}
