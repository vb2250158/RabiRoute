import type { AgentAdapterInvocation } from "@rabiroute/plugin-sdk";
import type { AgentManagerImplementationOptions } from "../manager/agentManagerHostPorts.js";
import type { AgentManagerDescriptor } from "../manager/agentManagerProviders.js";
import type { ApiOperationDefinition } from "../manager/apiOperationContract.js";
import { readAgentSessionBinding } from "./agentPluginSessionBinding.js";

export type AgentNativeOperation = (payload: any, invocation?: AgentAdapterInvocation) => unknown | Promise<unknown>;
export type AgentOperationInvoker = <T = unknown>(operation: string, payload: unknown, invocation?: AgentAdapterInvocation) => Promise<T>;
export type AgentOwnedManager = {
  operations: Record<string, AgentNativeOperation>;
  apiOperations?(invoke: AgentOperationInvoker): readonly ApiOperationDefinition[];
  start?(): void;
  unpublish?(): void;
  dispose?(): void | Promise<void>;
  serviceEndpoint?: unknown;
  deviceEndpoint?: unknown;
};

/** Original authority, stores and callbacks travel beside the cloned JSON payload. */
export function nativeOperations(functions: Record<string, (...args: any[]) => unknown>): Record<string, AgentNativeOperation> {
  return Object.fromEntries(Object.entries(functions).map(([name, implementation]) => [
    `native.${name}`,
    (_payload: unknown, invocation?: AgentAdapterInvocation) => {
      invocation?.assertCurrent?.();
      const args = invocation?.nativeArgs;
      if (!Array.isArray(args)) throw new Error("Original native invocation arguments are required.");
      return implementation(...args);
    }
  ]));
}

export function commonManagerOperations(
  options: AgentManagerImplementationOptions,
  descriptor: AgentManagerDescriptor,
  signal: AbortSignal,
  configureFields: Readonly<Record<string, string>> = {}
): Record<string, AgentNativeOperation> {
  return {
    ...((descriptor.manifest.capabilities.managedTasks as Record<string, unknown> | undefined)?.deliveryReceiptRecovery === true
      ? {} : { "endpoint.recover": () => undefined }),
    async scan(payload, invocation) {
      invocation?.assertCurrent?.();
      const combined = invocation?.signal ? AbortSignal.any([signal, invocation.signal]) : signal;
      const result = await options.host.runScan({
        kind: "provider",
        entry: options.scannerEntry,
        exportName: options.scannerExport,
        rootDir: options.host.rootDir,
        runtimes: [...options.host.getRuntimes()],
        manifest: descriptor.manifest,
        runtimeLayout: options.runtimeLayout ?? { packageRoot: options.host.packageRoot, stateRoot: options.host.rootDir },
        options: payload ?? {}
      }, { ...invocation, signal: combined });
      invocation?.assertCurrent?.();
      return result;
    },
    "binding.read": payload => readAgentSessionBinding(descriptor, payload.definition ?? payload),
    "binding.configure": (payload, invocation) => {
      invocation?.assertCurrent?.();
      if (options.host.readOnly()) throw new Error("Manager is read-only.");
      const definition = structuredClone(payload.definition ?? {});
      const body = payload.body ?? {};
      const bindings = descriptor.sessionBinding;
      if (body.enabled === true || body.enabled === false) {
        const adapters: string[] = Array.isArray(definition.agentAdapters) ? definition.agentAdapters : [];
        definition.agentAdapters = body.enabled === true
          ? [...new Set([...adapters, descriptor.type])]
          : adapters.filter(type => type !== descriptor.type);
      }
      const fields = { sessionId: bindings.sessionId, name: bindings.sessionName, workspace: bindings.workspace, ...configureFields };
      for (const [input, field] of Object.entries(fields)) {
        if (field && Object.prototype.hasOwnProperty.call(body, input)) definition[field] = String(body[input] ?? "");
      }
      return definition;
    }
  };
}

export function createAgentScanOperations(
  type: string,
  queryFields: Readonly<Record<string, number | null>>,
  invoke: AgentOperationInvoker,
  aliases: readonly string[] = [],
  legacyOperationIds: readonly string[] = []
): ApiOperationDefinition[] {
  const query = Object.fromEntries(Object.keys(queryFields).map(name => [name, { type: "string" }]));
  return [`/api/agent-adapters/scan/${type}`, ...aliases].map((pathname, index) => ({
    contract: {
      operationId: `agent.adapters.${type}.scan.get${index ? `.legacy${index}` : ""}`,
      ...(index === 0 && legacyOperationIds.length ? { aliases: legacyOperationIds } : {}),
      contractVersion: "1.0.0",
      method: "GET",
      pathTemplate: pathname,
      exposure: "public",
      transport: "http",
      description: "Explicit metadata scan owned by this active Agent package; never executes a prompt or creates a task.",
      request: {
        path: { type: "object", additionalProperties: false },
        query: { type: "object", properties: query, additionalProperties: false },
        headers: { type: "object" },
        body: { kind: "none" }
      },
      responses: {
        "200": { mediaType: "application/json", schema: {
          type: "object", required: ["agents", "cwdOptions"],
          properties: {
            agents: { type: "object", required: [type], properties: { [type]: { type: "object", additionalProperties: true } }, additionalProperties: false },
            cwdOptions: { type: "array", items: { type: "string" } }
          },
          additionalProperties: true
        } },
        "503": { mediaType: "application/json", schema: { type: "object", additionalProperties: true } },
        "500": { mediaType: "application/json", schema: { type: "object", additionalProperties: true } }
      },
      effects: { mode: "explicit-scan", description: "Only this published package scanner executes, under its original worker owner." },
      recovery: { strategy: "owner-read", description: "Keep the original Agent and selection. Refresh explicitly; no periodic scans or replacement tasks." },
      validators: [{ id: "owned-agent-scan", description: "The published owner selects its immutable scanner entry; queries cannot choose modules, create tasks or execute prompts." }]
    },
    async handler(input) {
      const payload = Object.fromEntries(Object.entries(queryFields).map(([name, fallback]) => {
        const value = input.url.searchParams.get(name);
        return [name, fallback === null ? value ?? undefined : Number(value || fallback)];
      }));
      try {
        return { status: 200, body: await invoke("scan", payload, { signal: input.signal, assertCurrent: () => input.signal?.throwIfAborted() }) };
      } catch (error) {
        return {
          status: (error as { statusCode?: number }).statusCode ?? 503,
          body: { code: -1, message: error instanceof Error ? error.message : "Agent scan is unavailable." }
        };
      }
    }
  }));
}


/** Native bridge functions retain original callback/authority references beside JSON request data. */
export function bridgeOperations(prefix: string, bridge: object): Record<string, AgentNativeOperation> {
  const methods = bridge as Record<string, unknown>;
  return Object.fromEntries(["resolveSource", "resolveTarget", "refresh", "transport"].map(name => [
    `${prefix}.${name}`,
    (_payload: unknown, invocation?: AgentAdapterInvocation) => {
      const args = invocation?.nativeArgs;
      if (!Array.isArray(args)) throw new Error("Original native bridge arguments are required.");
      const method = methods[name];
      if (name === "refresh" && method === undefined) return undefined;
      if (typeof method !== "function") throw new Error("Native bridge operation is unavailable.");
      return method.apply(bridge, args);
    }
  ]));
}
