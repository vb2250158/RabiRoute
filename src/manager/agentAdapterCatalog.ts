import type http from "node:http";
import { resolvePublishedAgentManagerProviders, type AgentManagerProvider } from "./agentManagerProviders.js";
import type { PluginGeneration } from "../plugin-kernel/generationRuntime.js";
import { scanAgentAdapters } from "../agentAdapters/managerApi.js";
import { createAgentAdapterCatalogOperations, runAgentAdapterCatalogOperation } from "./agentAdapterCatalogOperations.js";
import { AGENT_CATALOG_OPERATIONS } from "./agentAdapterCatalogContract.js";
import type { ApiOperationDefinition, ApiOperationRegistration } from "./apiOperationContract.js";
import { fileURLToPath } from "node:url";
import type {
  AgentScanOptions,
  AgentScanPerformanceOperation,
  AgentScanRuntimeSnapshot
} from "../agentAdapters/managerApi.js";
import { recordPerformanceOperation } from "../performance/performanceInstrumentation.js";
import type { AgentAdapterManifest } from "../shared/agentAdapterCapabilities.js";
import {
  AgentAdapterCatalogWorkerError,
} from "./agentAdapterCatalogWorkerPool.js";

export type AgentAdapterCatalogServiceOptions = {
  rootDir: string;
  getRuntimes(): Iterable<AgentScanRuntimeSnapshot>;
  listManifests?: () => Promise<AgentAdapterManifest[]>;
  getGeneration?: () => PluginGeneration | undefined;
  getProviders?: () => readonly AgentManagerProvider[];
  recordOperation?: (operation: string, durationMs: number, error?: boolean) => void;
};

export type AgentAdapterCatalogSnapshot = {
  schemaVersion: 1;
  adapters: Array<{
    type: AgentAdapterManifest["type"];
    label: string;
    maturity: AgentAdapterManifest["maturity"];
    transport: { protocol: string; mode: string };
    host?: { name: string; required: boolean };
    capabilities: AgentAdapterManifest["capabilities"];
  }>;
};

export type AgentAdapterCatalogRoutesContext = {
  service: AgentAdapterCatalogService;
  jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void;
};

export type AgentAdapterCatalogPluginMountOptions = AgentAdapterCatalogServiceOptions & {
  registerOperations(definitions: readonly ApiOperationDefinition[]): Promise<ApiOperationRegistration>;
  adopt(disposer: () => Promise<void>): void;
};

export type AgentAdapterCatalogPluginMount = {
  service: AgentAdapterCatalogService;
  cancel(reason?: string): Promise<void>;
  drain(): Promise<void>;
  stop(reason?: string): Promise<void>;
};

function cloneManifest(manifest: AgentAdapterManifest): AgentAdapterCatalogSnapshot["adapters"][number] {
  return {
    type: manifest.type,
    label: manifest.label,
    maturity: manifest.maturity,
    transport: { ...manifest.transport },
    ...(manifest.host ? { host: { ...manifest.host } } : {}),
    capabilities: {
      ...(manifest.capabilities.managedTasks
        ? { managedTasks: { ...manifest.capabilities.managedTasks } }
        : {})
    }
  };
}

export class AgentAdapterCatalogService {
  private readonly rootDir: string;
  private readonly getRuntimes: () => Iterable<AgentScanRuntimeSnapshot>;
  private readonly listManifests?: () => Promise<AgentAdapterManifest[]>;
  private readonly getProviders: () => readonly AgentManagerProvider[];
  private readonly recordOperation: (operation: string, durationMs: number, error?: boolean) => void;
  private state: "accepting" | "draining" | "stopped" = "accepting";
  private readonly active = new Set<Promise<unknown>>();
  private readonly controllers = new Set<AbortController>();

  constructor(options: AgentAdapterCatalogServiceOptions) {
    this.rootDir = options.rootDir;
    this.getRuntimes = options.getRuntimes;
    this.listManifests = options.listManifests;
    this.getProviders = options.getProviders ?? (() => resolvePublishedAgentManagerProviders(options.getGeneration?.()));
    this.recordOperation = options.recordOperation ?? recordPerformanceOperation;
  }

  async connectionOperation(request: http.IncomingMessage, url: URL, parsedBody?: Readonly<{ value: unknown; signal?: AbortSignal }>): Promise<unknown> {
    this.assertAccepting();
    return this.track(this.runControlled(controller => this.provider("dsh").invoke("connection", { method: request.method, pathname: url.pathname },
      { request, url, parsedBody, signal: controller.signal })));
  }

  async updateHooks(adapter: string): Promise<{ message: string }> {
    this.assertAccepting();
    return this.track(this.runControlled(controller => this.provider(adapter).invoke<{message:string}>("hooks.update", {}, { signal: controller.signal })));
  }

  async catalog(): Promise<AgentAdapterCatalogSnapshot> {
    this.assertAccepting();
    const manifests = this.listManifests ? await this.track(this.listManifests()) : this.getProviders().map(provider => provider.manifest as AgentAdapterManifest);
    return {
      schemaVersion: 1,
      adapters: manifests.map(cloneManifest)
    };
  }

  scanAll(options: AgentScanOptions = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.assertAccepting();
    return this.track(this.runControlled(controller => scanAgentAdapters({ rootDir:this.rootDir,
      runtimes:this.runtimeSnapshots(),providers:this.getProviders(),scanSignal:controller.signal },options),signal).then(result=>this.consumePerformanceOperations(result)));
  }

  scanDsh(options: AgentScanOptions = {}, signal?: AbortSignal): Promise<Record<string, unknown>> { return this.scanOne("dsh",options,signal); }

  scanOne(type:string,options:AgentScanOptions={},signal?:AbortSignal):Promise<Record<string,unknown>> {
    this.assertAccepting();
    return this.track(this.runControlled(controller=>this.provider(type).invoke<Record<string,unknown>>("scan",options,{signal:controller.signal}),signal));
  }

  private provider(type:string):AgentManagerProvider {
    const provider=this.getProviders().find(value=>value.type===type);
    if(!provider)throw Object.assign(new Error(`Agent plugin is unavailable: ${type}.`),{code:"AGENT_ADAPTER_UNAVAILABLE",statusCode:503});
    return provider;
  }

  scanGrokBot(options:AgentScanOptions={},signal?:AbortSignal):Promise<Record<string,unknown>> { return this.scanOne("grokBot",options,signal); }

  activeCount(): number {
    return this.active.size;
  }

  async cancel(reason?: string): Promise<void> {
    if (this.state === "stopped") {
      await this.settleActive();
      return;
    }
    for (const controller of this.controllers) controller.abort(reason);
    await this.settleActive();
  }

  async drain(): Promise<void> {
    if (this.state === "accepting") this.state = "draining";
    await this.settleActive();
  }

  async stop(reason?: string): Promise<void> {
    if (this.state === "stopped") {
      await this.settleActive();
        return;
    }
    this.state = "stopped";
    for (const controller of this.controllers) controller.abort(reason);
    await this.settleActive();
  }

  private assertAccepting(): void {
    if (this.state !== "accepting") {
      throw new AgentAdapterCatalogWorkerError("Agent adapter catalog is stopping.", "aborted");
    }
  }

  private runtimeSnapshots(): AgentScanRuntimeSnapshot[] {
    return [...this.getRuntimes()].map(runtime => ({ definition: runtime.definition }));
  }

  private runControlled<T>(
    run: (controller: AbortController) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    return run(controller).finally(() => {
      signal?.removeEventListener("abort", abort);
      this.controllers.delete(controller);
    });
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.active.add(operation);
    void operation.then(
      () => this.active.delete(operation),
      () => this.active.delete(operation)
    );
    return operation;
  }

  private async settleActive(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }

  private consumePerformanceOperations(result: Record<string, unknown>): Record<string, unknown> {
    const operations = Array.isArray(result.__performanceOperations)
      ? result.__performanceOperations as AgentScanPerformanceOperation[]
      : [];
    for (const operation of operations) {
      this.recordOperation(
        String(operation.operation || "manager.agent_scan.unknown"),
        Number(operation.durationMs || 0),
        operation.error === true
      );
    }
    const response = { ...result };
    delete response.__performanceOperations;
    return response;
  }
}

/** Transitional raw fixtures share the same owner as executable registration. */
export function handleAgentAdapterCatalogApi(request: http.IncomingMessage, requestUrl: URL,
  response: http.ServerResponse, context: AgentAdapterCatalogRoutesContext): boolean {
  const connection = ["/api/agent-adapters/dsh/connection", "/api/agent-adapters/dsh/connections"].includes(requestUrl.pathname);
  const definition = AGENT_CATALOG_OPERATIONS.find(item => item.path === requestUrl.pathname && item.method === request.method);
  if (!definition && !connection) return false;
  void runAgentAdapterCatalogOperation(definition?.key ?? (requestUrl.pathname.endsWith("/connections") ? "connections" : "connection"),
    request, requestUrl, response, context.service).then(result => {
      if (!response.writableEnded && !response.destroyed) context.jsonResponse(response, result.status, result.body);
    });
  return true;
}

export async function mountAgentAdapterCatalogPlugin(options: AgentAdapterCatalogPluginMountOptions): Promise<AgentAdapterCatalogPluginMount> {
  const service = new AgentAdapterCatalogService(options);
  let registration: ApiOperationRegistration | undefined;
  let retirement: Promise<void> | undefined;
  const retire = () => retirement ??= registration?.dispose() ?? Promise.resolve();
  let stopping: Promise<void> | undefined;
  const stop = (reason?: string) => stopping ??= (async () => {
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(retire),
      Promise.resolve().then(() => service.stop(reason))
    ]);
    const failures = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Agent adapter catalog owner cleanup failed.");
  })();
  options.adopt(stop);
  try { registration = await options.registerOperations(createAgentAdapterCatalogOperations(service)); }
  catch (error) {
    try { await stop(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Agent adapter catalog preparation and cleanup failed."); }
    throw error;
  }
  return {
    service,
    cancel: reason => service.cancel(reason),
    async drain() { await retire(); await service.drain(); },
    stop
  };
}
