import { getTimeoutMs } from "../shared/timeoutSettings.js";
import { BoundedStorageStartup, type StorageAttempt, type StorageStartupLimits } from "./boundedStorageStartup.js";
import { createStorageStartupProcess, type StorageStartupTask } from "./storageStartupProcess.js";
import type { PlanStorageStartupGateSummary } from "./planStorageStartupGate.js";

export type StartupProcessFactory = <Value>(task: StorageStartupTask) => StorageAttempt<Value>;

export class ProgressivePlanStorageStartup {
  private readonly recovered = new Map<string, PlanStorageStartupGateSummary>();

  constructor(private readonly options: Readonly<{
    rolesRoot: string;
    readOnly: boolean;
    terminateTimeoutMs?: number;
    limits?: StorageStartupLimits;
    processFactory?: StartupProcessFactory;
  }>) {}

  attempt(onProgress: (summary: PlanStorageStartupGateSummary) => void): StorageAttempt<PlanStorageStartupGateSummary> {
    const scope = new BoundedStorageStartup({ itemTimeoutMs: getTimeoutMs("backend.manager.progressivePlanStorageStartup.attempt.itemTimeoutMs", 60_000), batchTimeoutMs: getTimeoutMs("backend.manager.progressivePlanStorageStartup.attempt.batchTimeoutMs", 150_000), ...this.options.limits });
    const create: StartupProcessFactory = this.options.processFactory
      ?? (task => createStorageStartupProcess(task, this.options.terminateTimeoutMs));
    const summary: PlanStorageStartupGateSummary = {
      roles: this.recovered.size, migrated: 0, reconciled: 0, failures: [],
      skipped: this.options.readOnly, readyRoleIds: [...this.recovered.keys()]
    };
    const publish = (): void => {
      summary.readyRoleIds = [...this.recovered.keys()];
      summary.migrated = [...this.recovered.values()].reduce((total, item) => total + item.migrated, 0);
      summary.reconciled = [...this.recovered.values()].reduce((total, item) => total + item.reconciled, 0);
      const packageConflicts = [...this.recovered.values()].flatMap(item => item.packageConflicts ?? []);
      if (packageConflicts.length) summary.packageConflicts = packageConflicts;
      else delete summary.packageConflicts;
      onProgress(structuredClone(summary));
    };
    const result = (async () => {
      if (this.options.readOnly) return summary;
      let names: string[] = [];
      await scope.run([this.options.rolesRoot],
        root => create<string[]>({ kind: "directories", root }),
        (_root, value) => { names = value; summary.roles = names.length; publish(); },
        () => { summary.failures.push("roles:enumeration_unavailable"); publish(); });
      if (summary.failures.length) return summary;
      const discovered = new Set(names);
      for (const roleId of this.recovered.keys()) if (!discovered.has(roleId)) this.recovered.delete(roleId);
      await scope.run(names.filter(roleId => !this.recovered.has(roleId)),
        roleId => create<PlanStorageStartupGateSummary>({ kind: "plan", rolesRoot: this.options.rolesRoot, roleId }),
        (roleId, value) => {
          if (value.failures.length) summary.failures.push(`${roleId}:recovery_unavailable`);
          else this.recovered.set(roleId, value);
          publish();
        },
        roleId => { summary.failures.push(`${roleId}:recovery_unavailable`); publish(); });
      publish();
      return structuredClone(summary);
    })();
    return { result, cancel: () => scope.cancel() };
  }
}
