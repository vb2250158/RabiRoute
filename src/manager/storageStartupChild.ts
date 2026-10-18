import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

async function recordPlanStage(task: Extract<StorageStartupTask, { kind: "plan" }>, action: string, outcome: string, durationMs?: number): Promise<void> {
  try {
    const { resolveRuntimeLayout } = await import("../shared/runtimeLayout.js");
    const { createManagerOperationalLog } = await import("./operationalLog.js");
    const { stateRoot } = resolveRuntimeLayout(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
    const log = createManagerOperationalLog({ rootDir: stateRoot });
    log.record("info", "plan_storage_startup_stage", {
      group: "storage", action, outcome, durationMs, owner: "storage_startup_child",
      target: { type: "role", id: task.roleId }
    });
    await log.flush();
  } catch (loggingError) {
    process.stderr.write("Storage startup stage diagnostics unavailable.\n");
  }
}

async function planStage<Value>(task: Extract<StorageStartupTask, { kind: "plan" }>, action: string, run: () => Promise<Value> | Value): Promise<Value> {
  await recordPlanStage(task, action, "started");
  const start = performance.now();
  const value = await run();
  await recordPlanStage(task, action, "completed", performance.now() - start);
  return value;
}

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
        recoverRoleLifecycle: roleDir => planStage(task, "lifecycle", () => recoverPlanLifecycleTransitions(roleDir)),
        migrateRole: roleDir => planStage(task, "layout", () => migrateRolePlanLayoutAtStartup(roleDir)),
        recoverRoleFeedback: roleDir => planStage(task, "feedback", () => recoverPlanFeedbackStoreTransactions(roleDir)),
        recoverRolePackages: roleDir => planStage(task, "packages", () => recoverStoredPlanPackages(roleDir))
      });
    }
  }
}

let startupTask: StorageStartupTask | undefined;
try {
  const encoded = process.env.RABIROUTE_STORAGE_STARTUP_TASK;
  if (!encoded) throw new Error("Storage startup task is missing.");
  startupTask = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as StorageStartupTask;
  const value = await execute(startupTask);
  if (typeof process.send !== "function") throw new Error("Storage startup IPC is missing.");
  process.send({ ok: true, value }, () => { process.disconnect(); process.exit(0); });
} catch (error) {
  try {
    const { resolveRuntimeLayout } = await import("../shared/runtimeLayout.js");
    const { createManagerOperationalLog, managerOperationalError } = await import("./operationalLog.js");
    const { stateRoot } = resolveRuntimeLayout(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
    const log = createManagerOperationalLog({ rootDir: stateRoot });
    log.record("error", "plan_storage_startup_child_failed", {
      group: "storage", action: startupTask?.kind, owner: "storage_startup_child",
      ...(startupTask?.kind === "plan" ? { target: { type: "role", id: startupTask.roleId } } : {}),
      error: managerOperationalError(error, stateRoot)
    });
    await log.flush();
  } catch (loggingError) {
    // Keep the original failure opaque even when its private diagnostic cannot be saved.
    process.stderr.write("Storage startup failure diagnostics unavailable.\n");
  }
  if (typeof process.send === "function") {
    process.send({ ok: false }, () => { process.disconnect(); process.exit(1); });
  } else process.exit(1);
}
