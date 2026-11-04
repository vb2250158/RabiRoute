import fs from "node:fs/promises";
import path from "node:path";
import type { AgentAdapterProvider, AgentAdapterInvocation, AgentAdapterDescriptor } from "@rabiroute/plugin-sdk";
import type { PluginGeneration } from "../plugin-kernel/generationRuntime.js";
import type { PluginPackageCatalog, PluginProfile } from "../plugin-kernel/profile.js";
import type { AgentDeviceEndpointBridge, AgentServiceEndpointBridge } from "./agentEndpointDelivery.js";
import type { PluginManifest } from "../plugin-kernel/types.js";
import { readPluginManagementManifest } from "./pluginManagement.js";
import { resolveAgentAdapterProviders } from "../runtime/agentAdapterProviders.js";
import { agentIdentityForMessageSource, normalizeRabiMessageSource } from "../shared/rabiMessage.js";
import { scopedAgentManagerProviders, scopedAgentManagerProvider, invokeAgentProviderOperation } from "../agentAdapters/managerInvocation.js";

export type AgentManagerProvider = AgentAdapterProvider;
export { type AgentManagerDescriptor } from "../agentAdapters/managerDescriptor.js";
import { parseAgentManagerDescriptor, type AgentManagerDescriptor } from "../agentAdapters/managerDescriptor.js";

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** The published native graph is the sole source of executable Agent owners. */
export function resolvePublishedAgentManagerProviders(generation: PluginGeneration | undefined): AgentManagerProvider[] {
  return [...resolveAgentAdapterProviders(generation).providers.values()];
}

export function resolvePublishedAgentManagerProvider(generation: PluginGeneration | undefined, type: string): AgentManagerProvider {
  const provider = resolvePublishedAgentManagerProviders(generation).find(value => value.type === type);
  if (!provider) throw Object.assign(new Error(`Agent plugin is unavailable: ${type}.`), { code: "AGENT_ADAPTER_UNAVAILABLE", statusCode: 503 });
  return provider;
}

export function invokeAgentManagerOperation<T = unknown>(generation: PluginGeneration | undefined, type: string,
  operation: string, payload: unknown, invocation?: AgentAdapterInvocation): Promise<T> {
  const provider = scopedAgentManagerProvider(type, () => resolvePublishedAgentManagerProviders(generation));
  if (!provider) throw Object.assign(new Error(`Agent plugin is unavailable: ${type}.`), { code: "AGENT_ADAPTER_UNAVAILABLE", statusCode: 503 });
  return invokeAgentProviderOperation<T>(provider, operation, payload, invocation);
}

export function createPublishedAgentServiceEndpointBridge(getGeneration: () => PluginGeneration | undefined): AgentServiceEndpointBridge {
  const entries = () => scopedAgentManagerProviders(() => resolvePublishedAgentManagerProviders(getGeneration())).flatMap(provider => {
    const bridge = provider.serviceEndpoint;
    return object(bridge) && typeof bridge.owns === "function" ? [{ provider, bridge: bridge as unknown as AgentServiceEndpointBridge }] : [];
  });
  const owner = (endpoint: Parameters<AgentServiceEndpointBridge["owns"]>[0]) => {
    const selected = entries().find(({ bridge }) => bridge.owns(endpoint));
    if (!selected) throw Object.assign(new Error(`Agent service plugin is unavailable: ${endpoint.provider}.`), { code: "AGENT_ADAPTER_UNAVAILABLE", statusCode: 503 });
    return selected;
  };
  return {
    owns: endpoint => entries().some(({ bridge }) => bridge.owns(endpoint)),
    async resolveSource(request, principal) {
      for (const selected of entries().filter(({ provider, bridge }) => bridge.handlesSource?.(request, principal)
        ?? (request.messageSource ? agentIdentityForMessageSource(normalizeRabiMessageSource(request.messageSource))?.agentAdapter === provider.type : principal?.provider === provider.type))) {
        const result = await invokeAgentProviderOperation<Awaited<ReturnType<AgentServiceEndpointBridge["resolveSource"]>>>(selected.provider,
          "service.resolveSource", {}, { nativeArgs: [request, principal] });
        if (result) return result;
      }
      return undefined;
    },
    async resolveTarget(request) {
      for (const selected of entries().filter(({ provider, bridge }) => bridge.handlesTarget?.(request) ?? request.agentAdapter === provider.type)) {
        const result = await invokeAgentProviderOperation<Awaited<ReturnType<AgentServiceEndpointBridge["resolveTarget"]>>>(selected.provider,
          "service.resolveTarget", {}, { nativeArgs: [request] });
        if (result) return result;
      }
      return undefined;
    },
    authorize(endpoint, role) { owner(endpoint).bridge.authorize(endpoint, role); },
    async refresh(endpoint, role) {
      await invokeAgentProviderOperation(owner(endpoint).provider, "service.refresh", {}, { nativeArgs: [endpoint, role] });
    },
    resolveExecutionOptions(request, target) { return owner(target.endpoint!).bridge.resolveExecutionOptions(request, target); },
    transport(delivery, guard, reconcile) {
      return invokeAgentProviderOperation(owner(delivery.target).provider, "service.transport", {}, { nativeArgs: [delivery, guard, reconcile] });
    }
  };
}

export function createPublishedAgentDeviceEndpointBridge(getGeneration: () => PluginGeneration | undefined): AgentDeviceEndpointBridge {
  const entries = () => scopedAgentManagerProviders(() => resolvePublishedAgentManagerProviders(getGeneration())).flatMap(provider => {
    const bridge = provider.deviceEndpoint;
    return object(bridge) && typeof bridge.authorize === "function" ? [{ provider, bridge: bridge as unknown as AgentDeviceEndpointBridge }] : [];
  });
  const owner = (endpoint: Parameters<AgentDeviceEndpointBridge["authorize"]>[0]) => {
    const selected = entries().find(({ provider }) => provider.type === endpoint.provider);
    if (!selected) throw Object.assign(new Error(`Device Agent plugin is unavailable: ${endpoint.provider}.`), { code: "AGENT_ADAPTER_UNAVAILABLE", statusCode: 503 });
    return selected;
  };
  return {
    async resolveSource(request, principal) {
      for (const selected of entries().filter(({ bridge }) => bridge.handlesSource?.(request, principal) === true)) {
        const result = await invokeAgentProviderOperation<Awaited<ReturnType<AgentDeviceEndpointBridge["resolveSource"]>>>(selected.provider,
          "device.resolveSource", {}, { nativeArgs: [request, principal] });
        if (result) return result;
      }
      return undefined;
    },
    async resolveTarget(request) {
      for (const selected of entries().filter(({ provider, bridge }) => bridge.handlesTarget?.(request) ?? request.agentAdapter === provider.type)) {
        const result = await invokeAgentProviderOperation<Awaited<ReturnType<AgentDeviceEndpointBridge["resolveTarget"]>>>(selected.provider,
          "device.resolveTarget", {}, { nativeArgs: [request] });
        if (result) return result;
      }
      return undefined;
    },
    authorize(endpoint, role) { owner(endpoint).bridge.authorize(endpoint, role); },
    async refresh(endpoint, role) {
      await invokeAgentProviderOperation(owner(endpoint).provider, "device.refresh", {}, { nativeArgs: [endpoint, role] });
    },
    transport(delivery, guard, reconcile) {
      return invokeAgentProviderOperation(owner(delivery.target).provider, "device.transport", {}, { nativeArgs: [delivery, guard, reconcile] });
    }
  };
}


type DescriptorDiagnostic = { instanceId: string; message: string };
type InstalledManifestReader = (packageId: string, version: string) => Promise<PluginManifest>;

/** Disabled packages retain their saved binding metadata without activating code. */
export async function loadInstalledAgentManagerDescriptors(
  profile: PluginProfile,
  catalog: Pick<PluginPackageCatalog, "resolve">,
  readInstalledManifest: InstalledManifestReader = (packageId, version) => readPluginManagementManifest(catalog, packageId, version)
): Promise<{ descriptors: AgentManagerDescriptor[]; diagnostics: DescriptorDiagnostic[] }> {
  const packages = new Map<string, { packageId: string; version: string; instanceIds: string[] }>();
  for (const instance of profile.instances) {
    const key = JSON.stringify([instance.package, instance.version]);
    const item = packages.get(key);
    if (item) item.instanceIds.push(instance.id);
    else packages.set(key, { packageId: instance.package, version: instance.version, instanceIds: [instance.id] });
  }
  const inputs = [...packages.values()];
  const results: Array<{ descriptor?: AgentManagerDescriptor; error?: string }> = new Array(inputs.length);
  let cursor = 0;
  async function lane(): Promise<void> {
    while (cursor < inputs.length) {
      const index = cursor++;
      const item = inputs[index]!;
      try {
        const { sourceRoot } = await catalog.resolve(item.packageId, item.version);
        let text: string;
        try { text = await fs.readFile(path.join(sourceRoot, "agent-adapter.json"), "utf8"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") { results[index] = {}; continue; }
          throw error;
        }
        let value: unknown;
        try { value = JSON.parse(text); }
        catch { throw new Error("Agent package descriptor is invalid JSON."); }
        const parsed = parseAgentManagerDescriptor(value);
        const manifest = await readInstalledManifest(item.packageId, item.version);
        if (!manifest.provides.includes(parsed.capability)) throw new Error("Agent descriptor capability is not provided by its package.");
        results[index] = { descriptor: parsed };
      } catch (error) {
        results[index] = { error: error instanceof Error ? error.message : "Agent package metadata is unavailable." };
      }
    }
  }
  await Promise.all([lane(), lane()]);
  const descriptors = new Map<string, AgentManagerDescriptor>();
  const owners = new Map<string, string[]>();
  const conflicts = new Set<string>();
  const diagnostics: DescriptorDiagnostic[] = [];
  for (const [index, item] of inputs.entries()) {
    const result = results[index]!;
    if (result.error) {
      for (const instanceId of item.instanceIds) diagnostics.push({ instanceId, message: result.error });
      continue;
    }
    const value = result.descriptor;
    if (!value) continue;
    if (descriptors.has(value.type) || conflicts.has(value.type)) {
      const message = `Agent descriptor has multiple installed owners: ${value.type}.`;
      for (const instanceId of [...(owners.get(value.type) ?? []), ...item.instanceIds]) diagnostics.push({ instanceId, message });
      conflicts.add(value.type);
      descriptors.delete(value.type);
      owners.delete(value.type);
      continue;
    }
    descriptors.set(value.type, value);
    owners.set(value.type, item.instanceIds);
  }
  return { descriptors: [...descriptors.values()], diagnostics };
}
