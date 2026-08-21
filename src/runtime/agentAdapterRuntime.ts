import { builtinAgentAdapterDefinitions } from "../agentAdapters/builtinAgentAdapters.js";
import type { AgentAdapter, AgentAdapterDefinition } from "../agentAdapters/contracts.js";
import type { AgentAdapterManifest, AgentAdapterType } from "../shared/agentAdapterCapabilities.js";
import {
  RabiCordisHost,
  type RabiCordisFiber,
  type RabiCordisPlugin
} from "./cordisHost.js";

const AGENT_ADAPTER_REGISTRY_SERVICE = "rabi.agentAdapters";

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

export async function createAgentAdapterRuntime(
  definitions: AgentAdapterDefinition[] = builtinAgentAdapterDefinitions()
): Promise<AgentAdapterRuntime> {
  const host = new RabiCordisHost();
  try {
    await host.mount(registryServicePlugin);
    const registry = host.context.get(AGENT_ADAPTER_REGISTRY_SERVICE, true) as AgentAdapterRegistry;
    const fibers = new Map<AgentAdapterType, RabiCordisFiber>();
    for (const definition of definitions) {
      const fiber = await host.mount(definitionPlugin(definition));
      fibers.set(definition.manifest.type, fiber);
    }
    return {
      registry,
      fibers,
      dispose: () => host.dispose()
    };
  } catch (error) {
    await host.dispose();
    throw error;
  }
}

let builtinRuntimePromise: Promise<AgentAdapterRuntime> | undefined;

export function getBuiltinAgentAdapterRuntime(): Promise<AgentAdapterRuntime> {
  if (!builtinRuntimePromise) {
    builtinRuntimePromise = createAgentAdapterRuntime().catch((error) => {
      builtinRuntimePromise = undefined;
      throw error;
    });
  }
  return builtinRuntimePromise;
}
