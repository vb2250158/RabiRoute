import type { IncomingMessage, ServerResponse } from "node:http";

export type ManagerPluginRouteHandler = (
  request: IncomingMessage,
  url: URL,
  response: ServerResponse
) => boolean;

export type ManagerPluginRouteSnapshotEntry = {
  instanceId: string;
  handlerCount: number;
};

type ManagerPluginRouteBatch = {
  instanceId: string;
  handlers: readonly ManagerPluginRouteHandler[];
};

export class ManagerPluginRouteRegistry {
  private readonly batches: ManagerPluginRouteBatch[] = [];

  register(instanceId: string, handlers: readonly ManagerPluginRouteHandler[]): () => void {
    const normalizedInstanceId = instanceId.trim();
    if (!normalizedInstanceId) throw new Error("Manager plugin route instanceId is required.");
    const batch = { instanceId: normalizedInstanceId, handlers: [...handlers] };
    this.batches.push(batch);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = this.batches.indexOf(batch);
      if (index >= 0) this.batches.splice(index, 1);
    };
  }

  handle(request: IncomingMessage, url: URL, response: ServerResponse): boolean {
    for (const batch of this.batches) {
      for (const handler of batch.handlers) {
        if (handler(request, url, response)) return true;
      }
    }
    return false;
  }

  snapshot(): ManagerPluginRouteSnapshotEntry[] {
    const entries = new Map<string, ManagerPluginRouteSnapshotEntry>();
    for (const batch of this.batches) {
      const current = entries.get(batch.instanceId);
      if (current) {
        current.handlerCount += batch.handlers.length;
      } else {
        entries.set(batch.instanceId, {
          instanceId: batch.instanceId,
          handlerCount: batch.handlers.length
        });
      }
    }
    return [...entries.values()].map(entry => ({ ...entry }));
  }
}
