import type { Component } from "vue";
import type { TrustedWebPageRegistration } from "./pluginPages";
import type { TrustedWebSettingsRendererRegistration, TrustedWebStatusRendererRegistration } from "./pluginRenderers";
import type { TrustedWebThemeResourceRegistration } from "./pluginThemes";
import type { TrustedWebCommandRegistration } from "./pluginCommands";

export type WebContributionApi = Readonly<{
  instanceId: string;
  pluginId: string;
  registerPage(input: Omit<TrustedWebPageRegistration, "instanceId" | "pluginId">): () => void;
  registerSettingsRenderer(input: Omit<TrustedWebSettingsRendererRegistration, "instanceId" | "pluginId">): () => void;
  registerStatusRenderer(input: Omit<TrustedWebStatusRendererRegistration, "instanceId" | "pluginId">): () => void;
  registerTheme(input: Omit<TrustedWebThemeResourceRegistration, "instanceId" | "pluginId">): () => void;
  asComponent(value: Component): Component;
}>;

export type WebCommandContributionApi = Readonly<{
  registerCommand(input: Omit<TrustedWebCommandRegistration, "instanceId" | "pluginId">): () => void;
}>;

export function registerContributionPages(
  api: WebContributionApi,
  values: readonly Omit<TrustedWebPageRegistration, "instanceId" | "pluginId">[]
): readonly (() => void)[] {
  return values.map(value => api.registerPage(value));
}
