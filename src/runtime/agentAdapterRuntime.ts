import { builtinAgentAdapterDefinitions } from "../agentAdapters/builtinAgentAdapters.js";
import type { AgentAdapter, AgentAdapterDefinition } from "../agentAdapters/contracts.js";
import type { AgentAdapterManifest, AgentAdapterType } from "../shared/agentAdapterCapabilities.js";
import {
  RabiCordisHost,
  type RabiCordisFiber,
  type RabiCordisPlugin
} from "./cordisHost.js";
import { getBuiltinGatewayCordisRoot, type GatewayCordisRoot } from "./gatewayCordisRoot.js";

export const AGENT_ADAPTER_REGISTRY_SERVICE = "rabi.agentAdapters";
export const BUILTIN_AGENT_ADAPTER_RUNTIME_KEY = "rabi.runtime.agentAdapters.builtin";

export class AgentAdapterRegistry {
  private readonly definitions = new Map<AgentAdapterType, AgentAdapterDefinition>();

  register(definition: AgentAdapterDefinition): () => void {
    const type = definition.manifest.type;
    if (this.definitions.has(type)) {
      throw new Error(`Agent adapter already registered: ${type}`);
    }
    this.definitions.set(type, definition);
    return () => {
      if (this.definitions.get(type) === definition) {
        this.definitions.delete(type);
      }
    };
  }

  create(type: AgentAdapterType): AgentAdapter {
    const definition = this.definitions.get(type);
    if (!definition) {
      throw new Error(`Unsupported agent adapter: ${type}`);
    }
    return definition.create();
  }

  manifest(type: AgentAdapterType): AgentAdapterManifest | undefined {
    return this.definitions.get(type)?.manifest;
  }

  listManifests(): AgentAdapterManifest[] {
    return [...this.definitions.values()].map((definition) => definition.manifest);
  }
}

export type AgentAdapterRuntime = {
  registry: AgentAdapterRegistry;
  fibers: ReadonlyMap<AgentAdapterType, RabiCordisFiber>;
  dispose(): Promise<void>;
};

export type AgentAdapterRuntimeMount = {
  registry: AgentAdapterRegistry;
  fibers: ReadonlyMap<AgentAdapterType, RabiCordisFiber>;
  unmount(): Promise<void>;
};

const registryServicePlugin: RabiCordisPlugin = {
  name: "rabi:agent-adapter-registry",
  apply(ctx) {
    ctx.provide(AGENT_ADAPTER_REGISTRY_SERVICE, new AgentAdapterRegistry());
  }
};

function definitionPlugin(definition: AgentAdapterDefinition): RabiCordisPlugin {
  return {
    name: `rabi:agent-adapter/${definition.manifest.type}`,
    inject: [AGENT_ADAPTER_REGISTRY_SERVICE],
    apply(ctx) {
      const registry = ctx.get(AGENT_ADAPTER_REGISTRY_SERVICE, true) as AgentAdapterRegistry;
      ctx.effect(() => registry.register(definition), `register agent adapter ${definition.manifest.type}`);
    }
  };
}

async function disposeFibers(fibers: readonly RabiCordisFiber[]): Promise<void> {
  let firstError: unknown;
  for (const fiber of [...fibers].reverse()) {
    try {
      await fiber.dispose();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

export async function mountAgentAdapterRuntime(
  host: RabiCordisHost,
  definitions: AgentAdapterDefinition[] = builtinAgentAdapterDefinitions()
): Promise<AgentAdapterRuntimeMount> {
  const ownedFibers: RabiCordisFiber[] = [];
  try {
    const registryFiber = await host.mount(registryServicePlugin);
    ownedFibers.push(registryFiber);
    const registry = host.context.get(AGENT_ADAPTER_REGISTRY_SERVICE, true) as AgentAdapterRegistry;
    const fibers = new Map<AgentAdapterType, RabiCordisFiber>();
    for (const definition of definitions) {
      const fiber = await host.mount(definitionPlugin(definition));
      ownedFibers.push(fiber);
      fibers.set(definition.manifest.type, fiber);
    }

    let active = true;
    return {
      registry,
      fibers,
      async unmount() {
        if (!active) return;
        active = false;
        await disposeFibers(ownedFibers);
      }
    };
  } catch (error) {
    await disposeFibers(ownedFibers).catch(() => {});
    throw error;
  }
}

export async function createAgentAdapterRuntime(
  definitions: AgentAdapterDefinition[] = builtinAgentAdapterDefinitions()
): Promise<AgentAdapterRuntime> {
  const host = new RabiCordisHost();
  try {
    const mounted = await mountAgentAdapterRuntime(host, definitions);
    let disposePromise: Promise<void> | undefined;
    return {
      registry: mounted.registry,
      fibers: mounted.fibers,
      dispose() {
        disposePromise ??= host.dispose();
        return disposePromise;
      }
    };
  } catch (error) {
    await host.dispose();
    throw error;
  }
}

export function ensureAgentAdapterRuntime(
  root: GatewayCordisRoot
): Promise<AgentAdapterRuntimeMount> {
  return root.ensure(
    BUILTIN_AGENT_ADAPTER_RUNTIME_KEY,
    (host) => mountAgentAdapterRuntime(host)
  );
}

export function getBuiltinAgentAdapterRuntime(): Promise<AgentAdapterRuntimeMount> {
  return ensureAgentAdapterRuntime(getBuiltinGatewayCordisRoot());
}
