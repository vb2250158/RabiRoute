import type { GatewayMessageAdapterType, MessageAdapter, MessageAdapterDefinition, MessageAdapterManifest } from "../adapters/messageAdapter.js";

export const MESSAGE_ADAPTER_REGISTRY_SERVICE = "rabi.messageAdapters";

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
