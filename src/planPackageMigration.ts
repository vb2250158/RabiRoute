import fs from "node:fs";
import path from "node:path";
import type { PlanItem } from "./roleKnowledge.js";
import { migrateLegacyPackageGatePlan, planIsWaitingForPackage } from "./planPackageWaiting.js";
import { ensurePersonaPlanWorkflow } from "./personaPlanWorkflow.js";

export type PackageWaitingMigrationOptions = {
  roleDir?: string;
  rolesRoot?: string;
  apply?: boolean;
  now?: string;
};

export type PackageWaitingMigrationReport = {
  ok: true;
  mode: "dry-run" | "apply";
  scopeRoot: string;
  scannedPlanCount: number;
  changedPlanCount: number;
  waitingPackagePlanCount: number;
  resumedRunningPlanCount: number;
  skippedInvalidPlanCount: number;
  backupRoot: string | null;
  changes: Array<{
    file: string;
    planId: string;
    action: "waiting_package" | "resume_running";
    taskBindingPreserved: boolean;
  }>;
};

function planFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return planFiles(target);
    return entry.isFile() && entry.name.endsWith(".json") ? [target] : [];
  });
}

function roleDirectories(options: PackageWaitingMigrationOptions): { scopeRoot: string; roleDirs: string[] } {
  if (options.roleDir) {
    const roleDir = path.resolve(options.roleDir);
    return { scopeRoot: roleDir, roleDirs: [roleDir] };
  }
  if (!options.rolesRoot) throw new Error("Provide --role-dir=<path> or --roles-root=<path>.");
  const rolesRoot = path.resolve(options.rolesRoot);
  if (!fs.existsSync(rolesRoot)) return { scopeRoot: rolesRoot, roleDirs: [] };
  const roleDirs = fs.readdirSync(rolesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rolesRoot, entry.name));
  return { scopeRoot: rolesRoot, roleDirs };
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = file + ".package-waiting-" + process.pid + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  try {
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function migratePackageWaitingPlans(options: PackageWaitingMigrationOptions): PackageWaitingMigrationReport {
  const { scopeRoot, roleDirs } = roleDirectories(options);
  const apply = options.apply === true;
  const now = options.now || new Date().toISOString();
  const stamp = now.replace(/[:.]/g, "-");
  const backupRoot = path.join(scopeRoot, "migration-backups", "package-waiting-" + stamp);
  const changes: PackageWaitingMigrationReport["changes"] = [];
  let scannedPlanCount = 0;
  let waitingPackagePlanCount = 0;
  let skippedInvalidPlanCount = 0;

  for (const roleDir of roleDirs) {
    const workflow = ensurePersonaPlanWorkflow(roleDir).workflow;
    const activeRoot = path.join(roleDir, "plans", "items", "active");
    for (const file of planFiles(activeRoot)) {
      scannedPlanCount += 1;
      let plan: PlanItem;
      try {
        plan = JSON.parse(fs.readFileSync(file, "utf8")) as PlanItem;
      } catch {
        skippedInvalidPlanCount += 1;
        continue;
      }
      const migrated = migrateLegacyPackageGatePlan(plan, workflow, now);
      const effectivePlan = migrated?.plan || plan;
      if (planIsWaitingForPackage(effectivePlan, workflow)) waitingPackagePlanCount += 1;
      if (!migrated) continue;

      const originalTaskBinding = JSON.stringify(plan.taskBinding || null);
      const nextTaskBinding = JSON.stringify(migrated.plan.taskBinding || null);
      changes.push({
        file: path.relative(scopeRoot, file),
        planId: String(plan.id || ""),
        action: migrated.action,
        taskBindingPreserved: originalTaskBinding === nextTaskBinding
      });
      if (!apply) continue;
      const backupFile = path.join(backupRoot, path.relative(scopeRoot, file));
      fs.mkdirSync(path.dirname(backupFile), { recursive: true });
      fs.copyFileSync(file, backupFile);
      writeJsonAtomic(file, migrated.plan);
    }
  }

  return {
    ok: true,
    mode: apply ? "apply" : "dry-run",
    scopeRoot,
    scannedPlanCount,
    changedPlanCount: changes.length,
    waitingPackagePlanCount,
    resumedRunningPlanCount: changes.filter((item) => item.action === "resume_running").length,
    skippedInvalidPlanCount,
    backupRoot: apply && changes.length > 0 ? backupRoot : null,
    changes
  };
}
