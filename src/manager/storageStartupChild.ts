import fs from "node:fs";
import path from "node:path";
import { sanitizeRoleId, sanitizeConfigName } from "../shared/routeIdentity.js";
import { ManagerConfigRepository } from "./configRepository.js";
import { recoverRouteCatalogTransactions } from "./routeCatalogDurableTransaction.js";
import { readRouteCatalogDefinition, readRouteCatalogPersona } from "./routeCatalogTransaction.js";
import { runPlanStorageStartupGate } from "./planStorageStartupGate.js";
import { migrateRolePlanLayoutAtStartup } from "./planStorageStartupMigration.js";
import { recoverPlanLifecycleTransitions } from "../planStorageRepository.js";
import { recoverPlanFeedbackStoreTransactions } from "../planFeedback.js";
import { recoverStoredPlanPackages } from "../planStoragePackageRecovery.js";
import type { StorageStartupTask } from "./storageStartupProcess.js";

async function execute(task: StorageStartupTask): Promise<unknown> {
  switch (task.kind) {
    case "directories": {
      try {
        return fs.readdirSync(task.root, { withFileTypes: true })
          .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()
            && (task.catalog === "routes" ? sanitizeConfigName(entry.name) : sanitizeRoleId(entry.name)) === entry.name)
          .map(entry => entry.name).sort((left, right) => left.localeCompare(right));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    }
    case "catalog_recovery":
      recoverRouteCatalogTransactions(task.input);
      return true;
    case "route":
      return readRouteCatalogDefinition(new ManagerConfigRepository(task.input), task.configName);
    case "persona":
      return readRouteCatalogPersona(task.rolesRoot, task.roleId, task.roleFiles);
    case "plan": {
      const roleId = sanitizeRoleId(task.roleId);
      if (!roleId || roleId !== task.roleId) throw new Error("Invalid startup role identity.");
      return runPlanStorageStartupGate({
        rolesRoot: task.rolesRoot,
        roleDirectories: [path.join(task.rolesRoot, roleId)],
        readOnly: false,
        recoverRoleLifecycle: async roleDir => recoverPlanLifecycleTransitions(roleDir),
        migrateRole: async roleDir => migrateRolePlanLayoutAtStartup(roleDir),
        recoverRoleFeedback: async roleDir => recoverPlanFeedbackStoreTransactions(roleDir),
        recoverRolePackages: async roleDir => recoverStoredPlanPackages(roleDir)
      });
    }
  }
}

try {
  const encoded = process.env.RABIROUTE_STORAGE_STARTUP_TASK;
  if (!encoded) throw new Error("Storage startup task is missing.");
  const value = await execute(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as StorageStartupTask);
  if (typeof process.send !== "function") throw new Error("Storage startup IPC is missing.");
  process.send({ ok: true, value }, () => { process.disconnect(); process.exit(0); });
} catch {
  if (typeof process.send === "function") {
    process.send({ ok: false }, () => { process.disconnect(); process.exit(1); });
  } else process.exit(1);
}
