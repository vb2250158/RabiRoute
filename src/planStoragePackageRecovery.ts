import {
  recoverPlanStoragePackageTransactions
} from "./planStorageRepository.js";
import { archivedPlanDirectoryDominatesActive } from "./planStoragePolicy.js";

/**
 * Startup-only recovery of already prepared storage transactions. No network
 * command, package codec, or new import entry point is exposed here.
 *
 * Historical persona_sync_* transaction IDs remain opaque repository IDs. Keep
 * their manifests, staged payloads, receipts and conflict evidence unchanged.
 * This compatibility path may be retired only after every supported data root
 * has reconciled its prepared transactions (including missing-receipt cases),
 * all conflicts are explicitly resolved, and upgrades from older writers are
 * no longer supported. A successful scan on one machine is not that condition.
 */
export function recoverStoredPlanPackages(roleDir: string) {
  const recovered = recoverPlanStoragePackageTransactions(roleDir, {
    archiveDominatesActive: archivedPlanDirectoryDominatesActive
  });
  return {
    results: recovered.results,
    errors: recovered.failures.map(failure => ({
      receiptPath: failure.transactionPath,
      message: failure.error
    }))
  };
}
