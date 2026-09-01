export type ManagerRuntimeResourceStop = () => Promise<unknown> | unknown;

export type ManagerRuntimeOwnerHooks<TPublication> = Readonly<{
  fenceIngress: (reason: string) => void;
  publish: (publication: TPublication) => void;
  unpublish: (publication: TPublication) => void;
  resourceStopTimeoutMs?: number;
  teardownTimeoutMs?: number;
  onResourceStopError?: (owner: string, error: unknown) => void;
}>;

export const DEFAULT_MANAGER_RUNTIME_TEARDOWN_TIMEOUT_MS = 120_000;

type ManagerRuntimeOwnerState = "acquiring" | "published" | "tearing_down" | "stopped";

type ManagerRuntimeResource = {
  owner: string;
  stop: ManagerRuntimeResourceStop;
  stopFlight?: Promise<void>;
};

function requiredOwner(value: string): string {
  const owner = value.trim();
  if (!owner) throw new Error("Manager runtime resource owner is required.");
  return owner;
}

function aggregateTeardownFailure(reason: string, failures: readonly unknown[]): AggregateError {
  return new AggregateError(
    [...failures],
    `Manager runtime teardown was not fully confirmed: reason=${reason}.`
  );
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function resourceStopTimeoutError(owner: string, timeoutMs: number): Error {
  return new Error(`Manager runtime resource stop timed out: owner=${owner}; timeoutMs=${timeoutMs}.`);
}

/**
 * Owns one Manager application generation from the first acquired resource to
 * the final confirmed release. Callers may only publish after every mandatory
 * resource and request handler has been constructed.
 */
export class ManagerRuntimeOwner<TPublication> {
  private readonly resources: ManagerRuntimeResource[] = [];
  private state: ManagerRuntimeOwnerState = "acquiring";
  private publication: TPublication | undefined;
  private teardownFlight: Promise<void> | undefined;
  private teardownFailures: unknown[] | undefined;
  private readonly resourceStopTimeoutMs: number;
  private readonly teardownTimeoutMs: number;

  constructor(private readonly hooks: ManagerRuntimeOwnerHooks<TPublication>) {
    this.resourceStopTimeoutMs = positiveTimeout(hooks.resourceStopTimeoutMs, 10_000);
    this.teardownTimeoutMs = positiveTimeout(
      hooks.teardownTimeoutMs,
      DEFAULT_MANAGER_RUNTIME_TEARDOWN_TIMEOUT_MS
    );
  }

  register(owner: string, stop: ManagerRuntimeResourceStop): void {
    if (this.state !== "acquiring") {
      throw new Error(`Manager runtime cannot acquire '${owner}' while state=${this.state}.`);
    }
    this.resources.push({ owner: requiredOwner(owner), stop });
  }

  publish(publication: TPublication): void {
    if (this.state !== "acquiring") {
      throw new Error(`Manager runtime cannot publish while state=${this.state}.`);
    }
    this.hooks.publish(publication);
    this.publication = publication;
    this.state = "published";
  }

  isPublished(): boolean {
    return this.state === "published";
  }

  isTearingDown(): boolean {
    return this.state === "tearing_down" || this.state === "stopped";
  }

  teardown(reason: string, primaryError?: unknown): Promise<void> {
    if (this.teardownFlight) {
      if (primaryError !== undefined && this.state === "tearing_down") {
        this.teardownFailures?.push(primaryError);
      }
      return this.teardownFlight;
    }

    let resolveFlight = (): void => {};
    let rejectFlight = (_error: unknown): void => {};
    const flight = new Promise<void>((resolve, reject) => {
      resolveFlight = resolve;
      rejectFlight = reject;
    });
    this.teardownFlight = flight;
    this.state = "tearing_down";

    const failures: unknown[] = [];
    this.teardownFailures = failures;
    if (primaryError !== undefined) failures.push(primaryError);

    // These hooks intentionally run before the first await. No new business
    // request may enter once teardown() has returned to its caller.
    try {
      this.hooks.fenceIngress(reason);
    } catch (error) {
      failures.push(error);
    }
    if (this.publication !== undefined) {
      try {
        this.hooks.unpublish(this.publication);
      } catch (error) {
        failures.push(error);
      }
      this.publication = undefined;
    }

    const ownedResources = [...this.resources].reverse();
    const teardownDeadlineAt = Date.now() + this.teardownTimeoutMs;
    void (async () => {
      for (let index = 0; index < ownedResources.length; index += 1) {
        const resource = ownedResources[index];
        const resourcesRemaining = ownedResources.length - index;
        const remainingBudgetMs = Math.max(1, teardownDeadlineAt - Date.now());
        const fairResourceBudgetMs = Math.max(1, Math.floor(remainingBudgetMs / resourcesRemaining));
        const resourceBudgetMs = Math.min(this.resourceStopTimeoutMs, fairResourceBudgetMs);
        try {
          await this.stopResource(resource, resourceBudgetMs);
        } catch (error) {
          failures.push(error);
          try {
            this.hooks.onResourceStopError?.(resource.owner, error);
          } catch (observerError) {
            failures.push(observerError);
          }
        }
      }
      this.state = "stopped";
      if (failures.length > 0) throw aggregateTeardownFailure(reason, failures);
    })().then(resolveFlight, rejectFlight);

    return flight;
  }

  private stopResource(resource: ManagerRuntimeResource, timeoutMs: number): Promise<void> {
    if (!resource.stopFlight) {
      resource.stopFlight = new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error === undefined) resolve();
          else reject(error);
        };
        const timer = setTimeout(
          () => finish(resourceStopTimeoutError(resource.owner, timeoutMs)),
          timeoutMs
        );
        timer.unref?.();
        void Promise.resolve()
          .then(() => resource.stop())
          .then(() => finish(), error => finish(error));
      });
    }
    return resource.stopFlight;
  }
}
