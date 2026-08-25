import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ManagerPluginRouteDeclaration,
  ManagerPluginRouteHandler,
  ManagerPluginRouteRegistry
} from "./managerPluginRouteRegistry.js";
import { ManagerPluginRequestTracker } from "./managerPluginRequestTracker.js";

export type RabiManagerPluginEvent = Readonly<{
  instanceId: string;
  name: string;
  data: unknown;
}>;

export type RabiManagerPluginHostApi = Readonly<{
  instanceId: string;
  registerRoutes(routes: readonly ManagerPluginRouteDeclaration[]): () => void;
  track<T>(operation: Promise<T>): Promise<T>;
  publish(name: string, data: unknown): void;
  json(response: ServerResponse, statusCode: number, body: unknown): void;
  readJson<T>(request: IncomingMessage, limitBytes?: number): Promise<T>;
  stop(): Promise<void>;
}>;

export type CreateRabiManagerPluginHostApiOptions = Readonly<{
  instanceId: string;
  routes: ManagerPluginRouteRegistry;
  publishManagerEvent(eventType: "plugin_event", data: RabiManagerPluginEvent): void;
  drainTimeoutMs?: number;
}>;

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function validEventName(value: string): string {
  const normalized = required(value, "Plugin event name");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error(`Plugin event name is invalid: ${normalized}`);
  }
  return normalized;
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.setHeader("cache-control", "no-store");
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson<T>(request: IncomingMessage, limitBytes = 1_048_576): Promise<T> {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > 16 * 1024 * 1024) {
    throw new Error("Plugin JSON body limit must be between 1 and 16777216 bytes.");
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > limitBytes) throw new Error("Plugin request body exceeds its configured limit.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("Plugin request body is required.");
  return JSON.parse(text) as T;
}

/**
 * Creates the only Manager capability surface exposed to a package Bundle.
 * The API is scoped to one Profile instance and releases every registered
 * route before waiting for its accepted work during Fiber disposal.
 */
export function createRabiManagerPluginHostApi(
  options: CreateRabiManagerPluginHostApiOptions
): RabiManagerPluginHostApi {
  const instanceId = required(options.instanceId, "Manager plugin instanceId");
  const tracker = new ManagerPluginRequestTracker(options.drainTimeoutMs);
  const unregister = new Set<() => void>();
  let stopped = false;

  const release = (): void => {
    for (const dispose of [...unregister]) {
      unregister.delete(dispose);
      dispose();
    }
  };

  return Object.freeze({
    instanceId,
    registerRoutes(routes) {
      if (stopped) throw new Error(`Manager plugin host is stopping: ${instanceId}`);
      const dispose = options.routes.register(instanceId, routes.map(route => ({
        ...route,
        handler: tracker.wrap(route.handler)
      })));
      unregister.add(dispose);
      return () => {
        if (!unregister.delete(dispose)) return;
        dispose();
      };
    },
    track<T>(operation: Promise<T>): Promise<T> {
      if (stopped) return Promise.reject(new Error(`Manager plugin host is stopping: ${instanceId}`));
      return tracker.trackOperation(operation);
    },
    publish(name: string, data: unknown): void {
      if (stopped) return;
      options.publishManagerEvent("plugin_event", Object.freeze({
        instanceId,
        name: validEventName(name),
        data
      }));
    },
    json,
    readJson,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      release();
      await tracker.stop();
    }
  });
}