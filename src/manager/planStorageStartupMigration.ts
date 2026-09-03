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
