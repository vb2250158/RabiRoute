import {
  clearPlanCatalogAfterStartupMigration,
  normalizePlanForStartupMigration
} from "../roleKnowledge.js";
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
  return migrateRolePlanLayout(roleDir, {
    normalizePlan: normalizePlanForStartupMigration,
    onChanged: () => clearPlanCatalogAfterStartupMigration(roleDir)
  });
}
