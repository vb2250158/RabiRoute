import type { AgentAdapterManifest, AgentAdapterType } from "../../../src/shared/agentAdapterCapabilities";
import type { AgentAdapterCatalogMetadata, WebRendererContribution } from "../pluginRenderers";
import type { WebPluginCatalogPlugin } from "../pluginCatalogClient";

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }

export type AgentAdapterCatalogEntry = AgentAdapterCatalogMetadata & Readonly<{
  type: AgentAdapterType;
  manifest: AgentAdapterManifest;
  renderer: WebRendererContribution;
  available: true;
}>;

/** A Web card is available only alongside its own currently published native provider. */
export function agentAdapterCatalog(plugins: readonly WebPluginCatalogPlugin[], contributions: readonly unknown[], renderers: readonly WebRendererContribution[]): readonly AgentAdapterCatalogEntry[] {
  const entries = renderers.flatMap(renderer => {
    if (!renderer.agentType || !renderer.agentCapability || !renderer.agentCatalog) return [];
    const owner = plugins.find(plugin => plugin.status === "active" && plugin.instanceId === renderer.instanceId
      && plugin.pluginId === renderer.pluginId && plugin.manifest.id === renderer.pluginId
      && plugin.manifest.capabilities.includes(renderer.agentCapability!));
    if (!owner) return [];
    const providers = contributions.filter(value => record(value) && value.kind === "agent-adapter"
      && value.instanceId === owner.instanceId && value.pluginId === owner.pluginId
      && value.type === renderer.agentType && value.capability === renderer.agentCapability);
    if (providers.length !== 1) return [];
    const provider = providers[0] as RecordValue;
    const data = provider;
    if (!record(data.manifest) || data.manifest.type !== renderer.agentType || !record(data.manifest.capabilities)) return [];
    return [{ ...renderer.agentCatalog, type: renderer.agentType as AgentAdapterType,
      manifest: data.manifest as AgentAdapterManifest, renderer, available: true as const }];
  });
  return entries.filter(entry => entries.filter(other => other.type === entry.type).length === 1)
    .sort((a, b) => a.order - b.order || a.type.localeCompare(b.type));
}

export type ConfiguredAgentRow = AgentAdapterCatalogMetadata & Readonly<{
  type: AgentAdapterType; renderer?: WebRendererContribution; available: boolean;
}>;

export function configuredAgentRows(catalog: readonly AgentAdapterCatalogEntry[], configured: readonly AgentAdapterType[]): readonly ConfiguredAgentRow[] {
  return configured.map(type => catalog.find(entry => entry.type === type) ?? {
    type, title: type, note: "对应 Agent 插件未启用、未安装或加载失败，原配置与主控选择已保留。",
    icon: "mdi-puzzle-outline", order: 0, location: "local" as const, hasCwd: false, hasThread: false, available: false
  });
}

export function agentLocationLabel(location: AgentAdapterCatalogMetadata["location"]): string {
  return location === "cloud" ? "云端" : location === "device" ? "设备" : "本机";
}
