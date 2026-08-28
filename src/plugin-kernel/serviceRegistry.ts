import type { HostService, PluginServiceRegistration } from "./types.js";

export type ServiceRegistrySnapshot = Readonly<{ revision: number; services: ReadonlyMap<string, PluginServiceRegistration> }>;

export class ServiceRegistryDraft {
  readonly #services = new Map<string, PluginServiceRegistration>();
  constructor(hostServices: readonly HostService[]) {
    for (const service of hostServices) this.register("host", service.capability, service.value);
  }
  register(providerInstanceId: string, capability: string, value: unknown): void {
    const normalized = capability.trim();
    if (!normalized) throw new Error("Service capability is required.");
    const existing = this.#services.get(normalized);
    if (existing) throw new Error(`Service capability is already registered by ${existing.providerInstanceId}: ${normalized}.`);
    this.#services.set(normalized, Object.freeze({ capability: normalized, providerInstanceId, value }));
  }
  require<T>(capability: string): T {
    const normalized = capability.trim();
    const service = this.#services.get(normalized);
    if (!service) throw new Error(`Required plugin service is unavailable: ${normalized}.`);
    return service.value as T;
  }
  optional<T>(capability: string): T | undefined { return this.#services.get(capability.trim())?.value as T | undefined; }
  snapshot(revision: number): ServiceRegistrySnapshot { return Object.freeze({ revision, services: new Map(this.#services) }); }
}
