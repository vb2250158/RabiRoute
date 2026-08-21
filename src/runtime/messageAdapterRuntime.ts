import { builtinMessageAdapterDefinitions } from "../adapters/builtinMessageAdapters.js";
import type {
  MessageAdapter,
  MessageAdapterDefinition,
  MessageAdapterDispose,
  MessageAdapterManifest,
  GatewayMessageAdapterType
} from "../adapters/messageAdapter.js";
import {
  RabiCordisHost,
  type RabiCordisFiber,
  type RabiCordisPlugin
} from "./cordisHost.js";

const MESSAGE_ADAPTER_REGISTRY_SERVICE = "rabi.messageAdapters";

export class MessageAdapterRegistry {
  private readonly definitions = new Map<GatewayMessageAdapterType, MessageAdapterDefinition>();

  register(definition: MessageAdapterDefinition): () => void {
    const type = definition.manifest.type;
    if (this.definitions.has(type)) {
      throw new Error(`Message adapter already registered: ${type}`);
    }
    this.definitions.set(type, definition);
    return () => {
      if (this.definitions.get(type) === definition) {
        this.definitions.delete(type);
      }
    };
  }

  create(type: GatewayMessageAdapterType): MessageAdapter {
    const definition = this.definitions.get(type);
    if (!definition) {
      throw new Error(`Unsupported message adapter: ${type}`);
    }
    return definition.create();
  }

  manifest(type: GatewayMessageAdapterType): MessageAdapterManifest | undefined {
    return this.definitions.get(type)?.manifest;
  }

  listManifests(): MessageAdapterManifest[] {
    return [...this.definitions.values()].map((definition) => definition.manifest);
  }
}

export type MountedMessageAdapter = {
  type: GatewayMessageAdapterType;
  fiber: RabiCordisFiber;
  dispose(): Promise<void>;
};

export type MessageAdapterRuntime = {
  registry: MessageAdapterRegistry;
  definitionFibers: ReadonlyMap<GatewayMessageAdapterType, RabiCordisFiber>;
  mount(type: GatewayMessageAdapterType): Promise<MountedMessageAdapter>;
  dispose(): Promise<void>;
};

const registryServicePlugin: RabiCordisPlugin = {
  name: "rabi:message-adapter-registry",
  apply(ctx) {
    ctx.provide(MESSAGE_ADAPTER_REGISTRY_SERVICE, new MessageAdapterRegistry());
  }
};

function definitionPlugin(definition: MessageAdapterDefinition): RabiCordisPlugin {
  return {
    name: `rabi:message-adapter/${definition.manifest.type}`,
    inject: [MESSAGE_ADAPTER_REGISTRY_SERVICE],
    apply(ctx) {
      const registry = ctx.get(MESSAGE_ADAPTER_REGISTRY_SERVICE, true) as MessageAdapterRegistry;
      ctx.effect(
        () => registry.register(definition),
        `register message adapter ${definition.manifest.type}`
      );
    }
  };
}

function instancePlugin(type: GatewayMessageAdapterType): RabiCordisPlugin {
  return {
    name: `rabi:message-adapter-instance/${type}`,
    inject: [MESSAGE_ADAPTER_REGISTRY_SERVICE],
    async apply(ctx) {
      const registry = ctx.get(MESSAGE_ADAPTER_REGISTRY_SERVICE, true) as MessageAdapterRegistry;
      await ctx.effect(async () => {
        const adapter = registry.create(type);
        const dispose = await adapter.start();
        return typeof dispose === "function"
          ? dispose as MessageAdapterDispose
          : () => {};
      }, `start message adapter ${type}`);
    }
  };
}

export async function createMessageAdapterRuntime(
  definitions: MessageAdapterDefinition[] = builtinMessageAdapterDefinitions()
): Promise<MessageAdapterRuntime> {
  const host = new RabiCordisHost();
  const mounted = new Map<GatewayMessageAdapterType, MountedMessageAdapter>();
  try {
    await host.mount(registryServicePlugin);
    const registry = host.context.get(MESSAGE_ADAPTER_REGISTRY_SERVICE, true) as MessageAdapterRegistry;
    const definitionFibers = new Map<GatewayMessageAdapterType, RabiCordisFiber>();
    for (const definition of definitions) {
      const fiber = await host.mount(definitionPlugin(definition));
      definitionFibers.set(definition.manifest.type, fiber);
    }
    return {
      registry,
      definitionFibers,
      async mount(type) {
        if (mounted.has(type)) {
          throw new Error(`Message adapter already mounted: ${type}`);
        }
        const fiber = await host.mount(instancePlugin(type));
        let active = true;
        const instance: MountedMessageAdapter = {
          type,
          fiber,
          async dispose() {
            if (!active) return;
            active = false;
            if (mounted.get(type) === instance) {
              mounted.delete(type);
            }
            await fiber.dispose();
          }
        };
        mounted.set(type, instance);
        return instance;
      },
      async dispose() {
        mounted.clear();
        await host.dispose();
      }
    };
  } catch (error) {
    await host.dispose();
    throw error;
  }
}
