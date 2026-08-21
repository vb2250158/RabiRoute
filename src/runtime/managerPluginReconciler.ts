import { createHash } from "node:crypto";
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

function normalizedCapabilities(
  values: readonly string[] | undefined,
  field: string,
  instanceId: string
): string[] {
  const normalized = (values ?? []).map(value => value.trim()).filter(Boolean);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Duplicate ${field} capability in Manager plugin ${instanceId}.`);
  }
  return normalized;
}

function planDesiredDependencies(desired: readonly DesiredManagerPlugin[]): DesiredManagerPlugin[] {
  const enabled = desired.filter(item => item.enabled);
  const disabled = desired.filter(item => !item.enabled);
  const providerByCapability = new Map<string, DesiredManagerPlugin>();

  for (const item of enabled) {
    const instanceId = item.definition.instanceId;
    for (const capability of normalizedCapabilities(item.definition.provides, "provided", instanceId)) {
      const previous = providerByCapability.get(capability);
      if (previous) {
        throw new Error(
          `Manager capability ${capability} has multiple enabled providers: ${previous.definition.instanceId}, ${instanceId}`
        );
      }
      providerByCapability.set(capability, item);
    }
  }

  const dependencyRevisionByInstance = new Map<string, string>();
  const dependencyRevision = (
    item: DesiredManagerPlugin,
    stack: ReadonlySet<string> = new Set()
  ): string => {
    const instanceId = item.definition.instanceId;
    const cached = dependencyRevisionByInstance.get(instanceId);
    if (cached) return cached;
    if (stack.has(instanceId)) return `cycle:${instanceId}@${item.revision}`;

    const nextStack = new Set(stack);
    nextStack.add(instanceId);
    const dependencyTokens = [
      ...normalizedCapabilities(item.definition.requires, "required", instanceId)
        .map(capability => {
          const provider = providerByCapability.get(capability);
          return `required:${capability}@${provider ? dependencyRevision(provider, nextStack) : "missing"}`;
        }),
      ...normalizedCapabilities(item.definition.optional, "optional", instanceId)
        .map(capability => {
          const provider = providerByCapability.get(capability);
          return `optional:${capability}@${provider ? dependencyRevision(provider, nextStack) : "missing"}`;
        })
    ];
    const digest = createHash("sha256")
      .update(JSON.stringify({
        revision: item.revision,
        missingCapabilities: item.definition.missingCapabilities ?? [],
        dependencies: dependencyTokens
      }))
      .digest("hex");
    const resolved = `${item.revision}:dependency-sha256:${digest}`;
    dependencyRevisionByInstance.set(instanceId, resolved);
    return resolved;
  };

  const pending = [...enabled];
  const available = new Set<string>();
  const ordered: DesiredManagerPlugin[] = [];

  while (pending.length) {
    const findReady = (respectOptional: boolean): number => pending.findIndex(item => {
      const definition = item.definition;
      if ((definition.missingCapabilities ?? []).length) return false;
      const requirements = normalizedCapabilities(definition.requires, "required", definition.instanceId);
      if (!requirements.every(capability => available.has(capability))) return false;
      if (!respectOptional) return true;
      return normalizedCapabilities(definition.optional, "optional", definition.instanceId)
        .every(capability => !providerByCapability.has(capability) || available.has(capability));
    });
    let readyIndex = findReady(true);
    if (readyIndex < 0) readyIndex = findReady(false);
    if (readyIndex < 0) break;
    const [item] = pending.splice(readyIndex, 1);
    const definition = item!.definition;
    ordered.push({
      ...item!,
      definition: { ...definition, missingCapabilities: [] },
      revision: dependencyRevision(item!)
    });
    for (const capability of normalizedCapabilities(definition.provides, "provided", definition.instanceId)) {
      available.add(capability);
    }
  }

  const waiting = pending.map(item => {
    const definition = item.definition;
    const requirements = normalizedCapabilities(definition.requires, "required", definition.instanceId);
    const missingCapabilities = [
      ...new Set([
        ...(definition.missingCapabilities ?? []).map(value => value.trim()).filter(Boolean),
        ...requirements.filter(capability => !available.has(capability))
      ])
    ];
    return {
      ...item,
      definition: { ...definition, missingCapabilities },
      revision: `${dependencyRevision(item)}:missing:${missingCapabilities.join(",")}`
    };
  });

  return [...ordered, ...waiting, ...disabled];
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

    const desiredById = new Map(desired.map(item => [item.definition.instanceId, item]));
    const orderedIds = [
      ...desired.map(item => item.definition.instanceId),
      ...[...this.applied.keys()].filter(instanceId => !desiredById.has(instanceId))
    ];
    const changedIds = orderedIds.filter(instanceId => {
      const target = desiredById.get(instanceId);
      const current = this.applied.get(instanceId);
      const targetEnabled = target?.enabled ?? false;
      if (!current && !targetEnabled) return false;
      return !current || !targetEnabled || current.revision !== target?.revision;
    });
    changed.push(...changedIds);
    const failure = await this.applyBatch(changedIds, desiredById, rolledBack);

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
    const normalized = requested.map(item => {
      const instanceId = normalizedInstanceId(item.definition);
      if (seen.has(instanceId)) {
        throw new Error(`Duplicate desired manager plugin instance: ${instanceId}`);
      }
      seen.add(instanceId);
      const provides = normalizedCapabilities(item.definition.provides, "provided", instanceId);
      const requires = normalizedCapabilities(item.definition.requires, "required", instanceId);
      const optional = normalizedCapabilities(item.definition.optional, "optional", instanceId);
      return {
        definition: { ...item.definition, instanceId, provides, requires, optional },
        enabled: item.enabled,
        revision: normalizedRevision(item.revision, instanceId)
      };
    });
    return planDesiredDependencies(normalized);
  }

  private async applyBatch(
    changedIds: readonly string[],
    desiredById: ReadonlyMap<string, DesiredManagerPlugin>,
    rolledBack: string[]
  ): Promise<RabiPluginErrorSummary | undefined> {
    if (changedIds.length === 0) return undefined;

    const changed = new Set(changedIds);
    const previousOrder = [...this.applied.keys()];
    const previousById = new Map(
      previousOrder.flatMap(instanceId => {
        const current = this.applied.get(instanceId);
        return current ? [[instanceId, current] as const] : [];
      })
    );
    const deactivated: string[] = [];
    const activated: string[] = [];

    const rollbackActivated = async (): Promise<unknown | undefined> => {
      let firstError: unknown;
      for (const instanceId of [...activated].reverse()) {
        try {
          await this.runtime.plugins.get(instanceId)?.unmount();
        } catch (error) {
          firstError ??= error;
        }
        if (!this.runtime.plugins.has(instanceId)) {
          this.applied.delete(instanceId);
        }
      }
      return firstError;
    };

    const rollbackPrevious = async (): Promise<unknown | undefined> => {
      let firstError: unknown;
      const deactivatedSet = new Set(deactivated);
      for (const instanceId of previousOrder) {
        if (!deactivatedSet.has(instanceId)) continue;
        const previous = previousById.get(instanceId);
        if (!previous) continue;
        if (this.runtime.plugins.has(instanceId)) {
          firstError ??= new Error(
            `Manager plugin rollback blocked by active replacement: ${instanceId}`
          );
          continue;
        }
        try {
          await this.runtime.mount(previous.definition);
          this.applied.set(instanceId, previous);
          rolledBack.push(instanceId);
        } catch (error) {
          if (!this.runtime.plugins.has(instanceId)) {
            this.applied.delete(instanceId);
          }
          firstError ??= error;
        }
      }
      return firstError;
    };

    for (const instanceId of [...previousOrder].reverse()) {
      if (!changed.has(instanceId)) continue;
      const current = previousById.get(instanceId);
      if (!current) continue;
      try {
        await this.runtime.plugins.get(instanceId)?.unmount();
        this.applied.delete(instanceId);
        deactivated.push(instanceId);
      } catch (error) {
        if (!this.runtime.plugins.has(instanceId)) {
          this.applied.delete(instanceId);
          deactivated.push(instanceId);
        }
        const rollbackError = await rollbackPrevious();
        return rollbackError
          ? combinedRollbackError(error, rollbackError)
          : errorSummary("deactivation_failed", error);
      }
    }

    for (const target of desiredById.values()) {
      const instanceId = target.definition.instanceId;
      if (!target.enabled || !changed.has(instanceId)) continue;
      try {
        await this.runtime.mount(target.definition);
        this.applied.set(instanceId, {
          definition: target.definition,
          revision: target.revision
        });
        activated.push(instanceId);
      } catch (error) {
        const activationRollbackError = await rollbackActivated();
        const previousRollbackError = await rollbackPrevious();
        const rollbackError = activationRollbackError ?? previousRollbackError;
        return rollbackError
          ? combinedRollbackError(error, rollbackError)
          : errorSummary("activation_failed", error);
      }
    }

    return undefined;
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
