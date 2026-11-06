import type { MessageAdapterType, MessageEndpointType } from "../types";
import type { MessageEndpointCatalogMetadata, WebRendererContribution } from "../pluginRenderers";
import type { WebPluginCatalogPlugin } from "../pluginCatalogClient";

/** Match the same active owner, native host entry and endpoint capability as the trusted card contribution. */
export function gatewayEndpointTypesForWebCatalog(plugins: readonly WebPluginCatalogPlugin[], renderers: readonly WebRendererContribution[]): ReadonlySet<string> {
  // The internal schedule worker has no settings card; its native package still owns the Gateway requirement.
  const schedulers = plugins.some(plugin => plugin.status === "active"
    && plugin.manifest.hosts.includes("gateway") && plugin.manifest.capabilities.includes("endpoint.heartbeat@1")) ? ["heartbeat"] : [];
  return new Set([...schedulers, ...renderers.flatMap(renderer => renderer.endpointType && plugins.some(plugin =>
    plugin.status === "active" && plugin.instanceId === renderer.instanceId && plugin.pluginId === renderer.pluginId
    && plugin.manifest.id === renderer.pluginId && plugin.manifest.hosts.includes("gateway")
    && plugin.manifest.capabilities.includes(`endpoint.${renderer.endpointType}@1`)) ? [renderer.endpointType] : [])]);
}

export type MessageEndpointCatalogEntry = MessageEndpointCatalogMetadata & Readonly<{
  type: MessageEndpointType;
  renderer: WebRendererContribution;
  available: true;
}>;

/** Metadata comes from the same active plugin and trusted renderer as its card. */
export function messageEndpointCatalog(renderers: readonly WebRendererContribution[]): readonly MessageEndpointCatalogEntry[] {
  const entries = renderers.flatMap(renderer => renderer.endpointType && renderer.endpointType !== "heartbeat" && renderer.catalog
    ? [{ ...renderer.catalog, type: renderer.endpointType as MessageEndpointType, renderer, available: true as const }]
    : []);
  return entries.filter(entry => entries.filter(other => other.type === entry.type).length === 1)
    .sort((a, b) => a.group.order - b.group.order || a.order - b.order || a.type.localeCompare(b.type));
}

export function messageEndpointGroups(catalog: readonly MessageEndpointCatalogEntry[], configured: readonly MessageAdapterType[]) {
  const groups = new Map<string, { title: string; note: string; choices: Array<{ type: MessageEndpointType; title: string; note: string; icon: string; available: boolean }> }>();
  for (const item of catalog) {
    let group = groups.get(item.group.id);
    if (!group) { group = { title: item.group.title, note: item.group.note, choices: [] }; groups.set(item.group.id, group); }
    group.choices.push(item);
  }
  const missing = configured.filter(type => type !== "disabled" && type !== "heartbeat" && !catalog.some(item => item.type === type));
  if (missing.length) groups.set("unavailable", {
    title: "暂不可用的消息端", note: "原配置已保留。安装或启用对应插件后可继续使用。",
    choices: missing.map(type => ({ type: type as MessageEndpointType, title: type, note: "对应插件未启用、未安装或加载失败，原配置保留。", icon: "mdi-puzzle-outline", available: false }))
  });
  return [...groups.values()];
}
