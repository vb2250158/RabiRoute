import type {
  ManagerPluginDefinition,
  ManagerPluginRuntimeMount
} from "./managerPluginRuntime.js";
import {
  sanitizePluginErrorMessage,
  type RabiPluginErrorSummary
} from "./pluginCatalog.js";

export type DesiredManagerPlugin = {
  definition: ManagerPluginDefinition;
  enabled: boolean;
  revision: string;
};

export type ManagerPluginReconciliationState = "idle" | "reconciling" | "failed";

export type ManagerPluginReconciliationStatus = {
  revision: number;
  state: ManagerPluginReconciliationState;
  desired: string[];
  active: string[];
  changed: string[];
  rolledBack: string[];
  startedAt?: string;
  completedAt?: string;
  error?: RabiPluginErrorSummary;
};

type AppliedManagerPlugin = {
  definition: ManagerPluginDefinition;
  revision: string;
};

type ReconciliationFailure = {
  error: RabiPluginErrorSummary;
  rolledBack: boolean;
};

function normalizedInstanceId(definition: ManagerPluginDefinition): string {
  const instanceId = definition.instanceId.trim();
  if (!instanceId) throw new Error("Manager plugin instanceId is required.");
  return instanceId;
}

function normalizedRevision(value: string, instanceId: string): string {
  const revision = value.trim();
  if (!revision) throw new Error(`Manager plugin revision is required: ${instanceId}`);
  return revision;
}

function errorSummary(code: string, error: unknown): RabiPluginErrorSummary {
  return {
    code,
    message: sanitizePluginErrorMessage(error)
  };
}

function combinedRollbackError(activationError: unknown, rollbackError: unknown): RabiPluginErrorSummary {
  return {
    code: "rollback_failed",
    message: sanitizePluginErrorMessage(
      `Activation failed: ${sanitizePluginErrorMessage(activationError)}; rollback failed: ${sanitizePluginErrorMessage(rollbackError)}`
    )
  };
}

function cloneStatus(status: ManagerPluginReconciliationStatus): ManagerPluginReconciliationStatus {
  return {
    revision: status.revision,
    state: status.state,
    desired: [...status.desired],
    active: [...status.active],
    changed: [...status.changed],
    rolledBack: [...status.rolledBack],
    ...(status.startedAt ? { startedAt: status.startedAt } : {}),
    ...(status.completedAt ? { completedAt: status.completedAt } : {}),
    ...(status.error ? { error: { ...status.error } } : {})
  };
}

export class ManagerPluginReconciler {
  private readonly applied = new Map<string, AppliedManagerPlugin>();
  private queue: Promise<void> = Promise.resolve();
  private currentStatus: ManagerPluginReconciliationStatus = {
    revision: 0,
    state: "idle",
    desired: [],
    active: [],
    changed: [],
    rolledBack: []
  };

  constructor(private readonly runtime: ManagerPluginRuntimeMount) {}

  status(): ManagerPluginReconciliationStatus {
    return cloneStatus(this.currentStatus);
  }

  reconcile(desiredState: readonly DesiredManagerPlugin[]): Promise<ManagerPluginReconciliationStatus> {
    const snapshot = desiredState.map(item => ({ ...item }));
    const run = this.queue.then(() => this.reconcileNow(snapshot));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async reconcileNow(
    requested: readonly DesiredManagerPlugin[]
  ): Promise<ManagerPluginReconciliationStatus> {
    const revision = this.currentStatus.revision + 1;
    const startedAt = new Date().toISOString();
    let desired: DesiredManagerPlugin[];

    try {
      desired = this.normalizeDesired(requested);
    } catch (error) {
      this.currentStatus = {
        revision,
        state: "failed",
        desired: [],
        active: this.activeInstanceIds([]),
        changed: [],
        rolledBack: [],
        startedAt,
        completedAt: new Date().toISOString(),
        error: errorSummary("invalid_desired_state", error)
      };
      return this.status();
    }

    const desiredEnabled = desired.filter(item => item.enabled);
    const desiredIds = desiredEnabled.map(item => item.definition.instanceId);
    const changed: string[] = [];
    const rolledBack: string[] = [];
    this.currentStatus = {
      revision,
      state: "reconciling",
      desired: desiredIds,
      active: this.activeInstanceIds(desiredIds),
      changed,
      rolledBack,
      startedAt
    };

    let failure: RabiPluginErrorSummary | undefined;
    const desiredById = new Map(desired.map(item => [item.definition.instanceId, item]));
    const orderedIds = [
      ...desired.map(item => item.definition.instanceId),
      ...[...this.applied.keys()].filter(instanceId => !desiredById.has(instanceId))
    ];

    for (const instanceId of orderedIds) {
      const target = desiredById.get(instanceId);
      const current = this.applied.get(instanceId);
      const targetEnabled = target?.enabled ?? false;

      if (!current && !targetEnabled) continue;
      if (current && targetEnabled && current.revision === target?.revision) continue;

      changed.push(instanceId);
      const result = await this.applyChange(instanceId, current, targetEnabled ? target : undefined);
      if (result) {
        if (result.rolledBack) rolledBack.push(instanceId);
        failure = result.error;
        break;
      }
    }

    this.currentStatus = {
      revision,
      state: failure ? "failed" : "idle",
      desired: desiredIds,
      active: this.activeInstanceIds(desiredIds),
      changed: [...changed],
      rolledBack: [...rolledBack],
      startedAt,
      completedAt: new Date().toISOString(),
      ...(failure ? { error: failure } : {})
    };
    return this.status();
  }

  private normalizeDesired(requested: readonly DesiredManagerPlugin[]): DesiredManagerPlugin[] {
    const seen = new Set<string>();
    return requested.map(item => {
      const instanceId = normalizedInstanceId(item.definition);
      if (seen.has(instanceId)) {
        throw new Error(`Duplicate desired manager plugin instance: ${instanceId}`);
      }
      seen.add(instanceId);
      return {
        definition: { ...item.definition, instanceId },
        enabled: item.enabled,
        revision: normalizedRevision(item.revision, instanceId)
      };
    });
  }

  private async applyChange(
    instanceId: string,
    current: AppliedManagerPlugin | undefined,
    target: DesiredManagerPlugin | undefined
  ): Promise<ReconciliationFailure | undefined> {
    if (!current && target) {
      try {
        await this.runtime.mount(target.definition);
        this.applied.set(instanceId, {
          definition: target.definition,
          revision: target.revision
        });
        return undefined;
      } catch (error) {
        return { error: errorSummary("activation_failed", error), rolledBack: false };
      }
    }

    if (current && !target) {
      try {
        await this.runtime.plugins.get(instanceId)?.unmount();
        this.applied.delete(instanceId);
        return undefined;
      } catch (error) {
        if (this.runtime.plugins.has(instanceId)) {
          return { error: errorSummary("deactivation_failed", error), rolledBack: false };
        }
        try {
          await this.runtime.mount(current.definition);
          return { error: errorSummary("deactivation_failed", error), rolledBack: true };
        } catch (rollbackError) {
          this.applied.delete(instanceId);
          return { error: combinedRollbackError(error, rollbackError), rolledBack: false };
        }
      }
    }

    if (!current || !target) return undefined;

    try {
      await this.runtime.plugins.get(instanceId)?.unmount();
    } catch (error) {
      if (this.runtime.plugins.has(instanceId)) {
        return { error: errorSummary("deactivation_failed", error), rolledBack: false };
      }
      try {
        await this.runtime.mount(current.definition);
        return { error: errorSummary("deactivation_failed", error), rolledBack: true };
      } catch (rollbackError) {
        this.applied.delete(instanceId);
        return { error: combinedRollbackError(error, rollbackError), rolledBack: false };
      }
    }

    try {
      await this.runtime.mount(target.definition);
      this.applied.set(instanceId, {
        definition: target.definition,
        revision: target.revision
      });
      return undefined;
    } catch (activationError) {
      try {
        await this.runtime.mount(current.definition);
        return { error: errorSummary("activation_failed", activationError), rolledBack: true };
      } catch (rollbackError) {
        this.applied.delete(instanceId);
        return { error: combinedRollbackError(activationError, rollbackError), rolledBack: false };
      }
    }
  }

  private activeInstanceIds(preferredOrder: readonly string[]): string[] {
    const active = new Set(
      this.runtime.catalog.snapshot().plugins
        .filter(plugin => plugin.status === "active")
        .map(plugin => plugin.instanceId)
    );
    return [
      ...preferredOrder.filter(instanceId => active.delete(instanceId)),
      ...active
    ];
  }
}
