import type http from "node:http";
import type { ManagerPluginRouteHandler } from "./managerPluginRouteRegistry.js";

export class ManagerPluginRequestTracker {
  private accepting = true;
  private readonly activeResponses = new Map<Promise<void>, http.ServerResponse>();
  private readonly activeOperations = new Set<Promise<unknown>>();

  constructor(private readonly drainTimeoutMs = 30_000) {}

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
    const tracked = Promise.resolve(operation);
    this.activeOperations.add(tracked);
    void tracked.then(
      () => this.activeOperations.delete(tracked),
      () => this.activeOperations.delete(tracked)
    );
    return tracked;
  }

  async stop(): Promise<void> {
    this.accepting = false;
    const responses = [...this.activeResponses.keys()];
    if (responses.length > 0) {
      let timeout: NodeJS.Timeout | undefined;
      const drained = Promise.allSettled(responses);
      const timedOut = await Promise.race([
        drained.then(() => false),
        new Promise<boolean>(resolve => {
          timeout = setTimeout(() => resolve(true), this.drainTimeoutMs);
          timeout.unref?.();
        })
      ]);
      if (timeout) clearTimeout(timeout);
      if (timedOut) {
        for (const response of this.activeResponses.values()) {
          if (!response.writableEnded && !response.destroyed) response.destroy();
        }
        await Promise.allSettled([...this.activeResponses.keys()]);
      }
    }
    while (this.activeOperations.size > 0) {
      await Promise.allSettled([...this.activeOperations]);
    }
  }

  activeCount(): number {
    return this.activeResponses.size;
  }

  activeOperationCount(): number {
    return this.activeOperations.size;
  }
}
