import { getTimeoutMs } from "../shared/timeoutSettings.js";
import type http from "node:http";
import type { ManagerPluginRouteHandler } from "./managerPluginRouteRegistry.js";
import { automaticCodeRuntime } from "../plugin-kernel/automaticCodeRuntime.js";

export class ManagerPluginRequestTracker {
  private accepting = true;
  private readonly activeResponses = new Map<Promise<void>, http.ServerResponse>();
  private readonly activeOperations = new Set<Promise<unknown>>();

  constructor(private readonly drainTimeoutMs = getTimeoutMs("backend.manager.managerPluginRequestTracker.owner.drainTimeoutMs", 30_000)) {}

  wrap(handler: ManagerPluginRouteHandler): ManagerPluginRouteHandler {
    return (request, url, response) => {
      if (!this.accepting) return false;
      let settle!: () => void;
      const completed = new Promise<void>(resolve => { settle = resolve; });
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        response.off("finish", finish);
        response.off("close", finish);
        settle();
      };
      response.once("finish", finish);
      response.once("close", finish);
      let handled: boolean;
      try {
        handled = handler(request, url, response);
      } catch (error) {
        finish();
        throw error;
      }
      if (!handled) {
        finish();
        return false;
      }
      this.activeResponses.set(completed, response);
      void completed.then(
        () => this.activeResponses.delete(completed),
        () => this.activeResponses.delete(completed)
      );
      return true;
    };
  }

  trackOperation<T>(operation: Promise<T>): Promise<T> {
    const tracked = automaticCodeRuntime.trackOperation(Promise.resolve(operation));
    this.activeOperations.add(tracked);
    void tracked.then(
      () => this.activeOperations.delete(tracked),
      () => this.activeOperations.delete(tracked)
    );
    return tracked;
  }

  async stop(): Promise<void> {
    this.accepting = false;
    const deadlineAt = performance.now() + getTimeoutMs("plugin.drain", this.drainTimeoutMs);
    const timedOut = (): never => {
      for (const response of this.activeResponses.values()) {
        if (!response.writableEnded && !response.destroyed) response.destroy();
      }
      // Keep the unfinished operations observable; a rejected drain is not retirement.
      throw new Error(`Manager plugin request drain timed out: responses=${this.activeResponses.size}; operations=${this.activeOperations.size}.`);
    };
    while (this.activeResponses.size > 0 || this.activeOperations.size > 0) {
      // Completed children can keep the microtask queue busy ahead of timers.
      if (performance.now() >= deadlineAt) timedOut();
      let timeout: NodeJS.Timeout | undefined;
      let drained: boolean;
      try {
        drained = await Promise.race([
          Promise.allSettled([...this.activeResponses.keys(), ...this.activeOperations]).then(() => true),
          new Promise<false>(resolve => {
            timeout = setTimeout(() => resolve(false), Math.max(1, deadlineAt - performance.now()));
          })
        ]);
      } finally { if (timeout) clearTimeout(timeout); }
      if (drained) continue;
      timedOut();
    }
  }

  activeCount(): number {
    return this.activeResponses.size;
  }

  activeOperationCount(): number {
    return this.activeOperations.size;
  }
}
