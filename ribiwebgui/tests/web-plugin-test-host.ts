import type { Component } from "vue";
import { registerTrustedWebPage, type TrustedWebPageRegistration } from "../src/pluginPages";
import {
  registerTrustedWebSettingsRenderer,
  registerTrustedWebStatusRenderer,
  type TrustedWebSettingsRendererRegistration,
  type TrustedWebStatusRendererRegistration
} from "../src/pluginRenderers";
import {
  registerTrustedWebThemeResource,
  type TrustedWebThemeResourceRegistration
} from "../src/pluginThemes";

type TestWebPluginApi = Readonly<{
  instanceId: string;
  pluginId: string;
  registerPage(input: Omit<TrustedWebPageRegistration, "instanceId" | "pluginId">): () => void;
  registerSettingsRenderer(input: Omit<TrustedWebSettingsRendererRegistration, "instanceId" | "pluginId">): () => void;
  registerStatusRenderer(input: Omit<TrustedWebStatusRendererRegistration, "instanceId" | "pluginId">): () => void;
  registerTheme(input: Omit<TrustedWebThemeResourceRegistration, "instanceId" | "pluginId">): () => void;
  asComponent(value: Component): Component;
}>;

type Activate = (api: TestWebPluginApi) => readonly (() => void)[];

export function activateWebPluginForTest(
  owner: Readonly<{ instanceId: string; pluginId: string }>,
  activate: Activate
): () => void {
  const api: TestWebPluginApi = Object.freeze({
    ...owner,
    registerPage: input => registerTrustedWebPage({ ...input, ...owner }),
    registerSettingsRenderer: input => registerTrustedWebSettingsRenderer({ ...input, ...owner }),
    registerStatusRenderer: input => registerTrustedWebStatusRenderer({ ...input, ...owner }),
    registerTheme: input => registerTrustedWebThemeResource({ ...input, ...owner }),
    asComponent: value => value
  });
  const disposers = activate(api);
  return () => {
    for (const dispose of [...disposers].reverse()) dispose();
  };
}
