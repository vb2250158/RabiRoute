/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "vue";
import type { TrustedWebPageRegistration } from "../pluginPages";
import type { TrustedWebSettingsRendererRegistration, TrustedWebStatusRendererRegistration } from "../pluginRenderers";
import type { TrustedWebThemeResourceRegistration } from "../pluginThemes";
import { activate as activateCore } from "./builtin/core";
import { activate as activatePersona } from "./builtin/persona";
import { activate as activateDesktop } from "./builtin/desktop";
import { activate as activateXiaomiHome } from "./builtin/xiaomi-home";

type Registration = {
  kind: string;
  instanceId: string;
  routeId?: string;
  rendererId?: string;
  placementId?: string;
  themeId?: string;
};
type InstanceApi = Readonly<{
  instanceId: string; pluginId: string; asComponent(value: Component): Component;
  registerPage(input: Omit<TrustedWebPageRegistration, "instanceId" | "pluginId">): () => void;
  registerSettingsRenderer(input: Omit<TrustedWebSettingsRendererRegistration, "instanceId" | "pluginId">): () => void;
  registerStatusRenderer(input: Omit<TrustedWebStatusRendererRegistration, "instanceId" | "pluginId">): () => void;
  registerTheme(input: Omit<TrustedWebThemeResourceRegistration, "instanceId" | "pluginId">): () => void;
}>;
function moduleApi(instanceId: string, registrations: Registration[]) {
  const register = (kind: string, input: object) => {
    const value = input as Record<string, unknown>;
    const item = {
      kind,
      instanceId,
      routeId: value.routeId as string | undefined,
      rendererId: value.rendererId as string | undefined,
      placementId: value.placementId as string | undefined,
      themeId: value.themeId as string | undefined
    };
    registrations.push(item);
    return () => { const index = registrations.indexOf(item); if (index >= 0) registrations.splice(index, 1); };
  };
  const api: InstanceApi = {
    instanceId, pluginId: `io.rabiroute.${instanceId}`, asComponent: value => value,
    registerPage: input => register("page", input), registerSettingsRenderer: input => register("settings", input),
    registerStatusRenderer: input => register("status", input), registerTheme: input => register("theme", input)
  };
  return { instanceIds: [instanceId], forInstance: () => api };
}
test("independent Web plugin entries register only their own contributions", () => {
  const registrations: Registration[] = [];
  activateCore(moduleApi("manager:core", registrations));
  activatePersona(moduleApi("manager:persona", registrations));
  activateDesktop(moduleApi("manager:desktop", registrations));
  activateXiaomiHome(moduleApi("manager:xiaomi-home", registrations));
  assert.deepEqual(registrations.filter(item => item.instanceId === "manager:core" && item.kind === "page").map(item => item.routeId), ["route.overview", "global.lan-agents", "global.settings", "global.docs"]);
  assert.deepEqual(registrations.filter(item => item.instanceId === "manager:persona" && item.kind === "page").map(item => item.routeId), ["route.persona", "route.persona-document", "route.knowledge", "route.persona-sync"]);
  assert.deepEqual(registrations.filter(item => item.instanceId === "manager:desktop").map(item => item.rendererId), ["builtin.desktop-settings.v1"]);
  assert.deepEqual(registrations.filter(item => item.instanceId === "manager:desktop").map(item => item.placementId), ["global.settings.sections"]);
  assert.deepEqual(registrations.filter(item => item.instanceId === "manager:xiaomi-home").map(item => item.rendererId), ["builtin.xiaomi-home-message-endpoint.v1", "builtin.xiaomi-home-auth.v1"]);
  assert.deepEqual(registrations.filter(item => item.instanceId === "manager:xiaomi-home").map(item => item.placementId), ["route.adapters.message-endpoint-settings", "route.adapters.message-endpoint-settings"]);
});
