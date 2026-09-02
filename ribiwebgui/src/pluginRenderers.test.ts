/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defineComponent } from "vue";
import {
  registerTrustedWebSettingsRenderer,
  registerTrustedWebStatusRenderer,
  registeredWebSettingsRenderers,
  registeredWebStatusRenderers,
  resolveWebSettingsCatalog,
  resolveWebStatusCatalog,
  webRenderersAt
} from "./pluginRenderers";

function settings(rendererId: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "settings-section",
    surface: "shared.settings",
    id: "trusted-settings",
    instanceId: "manager:trusted",
    pluginId: "package:trusted",
    hosts: ["web"],
    slot: "trusted",
    rendererId,
    schemaId: "trusted.settings.v1",
    readCommandId: "trusted.settings.read",
    writeCommandId: "trusted.settings.write",
    ...overrides
  };
}

function status(rendererId: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "status-card",
    surface: "shared.status",
    id: "trusted-status",
    instanceId: "manager:trusted",
    pluginId: "package:trusted",
    hosts: ["web"],
    slot: "trusted",
    rendererId,
    queryId: "trusted.status",
    ...overrides
  };
}

test("renderer registry starts empty until an active Web Bundle registers contributions", () => {
  assert.deepEqual(registeredWebSettingsRenderers(), []);
  assert.deepEqual(registeredWebStatusRenderers(), []);
});
test("custom trusted renderers resolve to real components and disappear after disposal", () => {
  const settingsId = "trusted.settings-renderer.v1";
  const statusId = "trusted.status-renderer.v1";
  const disposeSettings = registerTrustedWebSettingsRenderer({
    instanceId: "manager:trusted",
    pluginId: "package:trusted",
    rendererId: settingsId,
    placementId: "trusted.settings.placement",
    allowedSlots: ["trusted"],
    contributionKind: "settings-section",
    contributionSurface: "shared.settings",
    schemaId: "trusted.settings.v1",
    readCommandId: "trusted.settings.read",
    writeCommandId: "trusted.settings.write",
    loader: async () => defineComponent({ template: "<div>settings</div>" })
  });
  const disposeStatus = registerTrustedWebStatusRenderer({
    instanceId: "manager:trusted",
    pluginId: "package:trusted",
    rendererId: statusId,
    placementId: "trusted.status.placement",
    allowedSlots: ["trusted"],
    queryId: "trusted.status",
    loader: async () => defineComponent({ template: "<div>status</div>" })
  });
  try {
    const settingsCatalog = resolveWebSettingsCatalog([settings(settingsId)]);
    const statusCatalog = resolveWebStatusCatalog([status(statusId)]);
    assert.equal(webRenderersAt(settingsCatalog, "trusted.settings.placement").length, 1);
    assert.equal(webRenderersAt(statusCatalog, "trusted.status.placement").length, 1);
    assert.equal(typeof settingsCatalog[0]?.component, "object");
    assert.deepEqual(resolveWebSettingsCatalog([settings(settingsId, { schemaId: "unknown" })]), []);
    assert.deepEqual(resolveWebSettingsCatalog([settings(settingsId, { instanceId: "manager:other" })]), []);
    assert.deepEqual(resolveWebSettingsCatalog([settings(settingsId, { pluginId: "package:other" })]), []);
    assert.deepEqual(resolveWebStatusCatalog([status(statusId, { queryId: "unknown" })]), []);
    assert.deepEqual(resolveWebStatusCatalog([status(statusId, { instanceId: "manager:other" })]), []);
    assert.deepEqual(resolveWebStatusCatalog([status(statusId, { pluginId: "package:other" })]), []);
  } finally {
    disposeStatus();
    disposeSettings();
  }
  assert.deepEqual(resolveWebSettingsCatalog([settings(settingsId)]), []);
  assert.deepEqual(resolveWebStatusCatalog([status(statusId)]), []);
});

test("trusted renderer registration rejects duplicate renderer IDs", () => {
  const dispose = registerTrustedWebStatusRenderer({
    instanceId: "manager:trusted", pluginId: "package:trusted", rendererId: "trusted.status.duplicate.v1",
    placementId: "trusted.status.placement", allowedSlots: ["trusted"], queryId: "trusted.status",
    loader: async () => defineComponent({ template: "<div />" })
  });
  try {
    assert.throws(() => registerTrustedWebStatusRenderer({
      instanceId: "manager:other", pluginId: "package:other", rendererId: "trusted.status.duplicate.v1",
      placementId: "trusted.status.placement", allowedSlots: ["trusted"], queryId: "trusted.status",
      loader: async () => defineComponent({ template: "<div />" })
    }), /already registered/);
  } finally { dispose(); }
});
test("message-endpoint settings resolve only through their Route adapter surface", () => {
  const rendererId = "trusted.message-endpoint-settings.v1";
  const dispose = registerTrustedWebSettingsRenderer({
    instanceId: "manager:trusted",
    pluginId: "package:trusted",
    rendererId,
    placementId: "route.adapters.message-endpoint-settings",
    allowedSlots: ["xiaomiHome"],
    contributionKind: "message-endpoint-settings",
    contributionSurface: "route.adapters",
    schemaId: "trusted.settings.v1",
    readCommandId: "trusted.settings.read",
    writeCommandId: "trusted.settings.write",
    loader: async () => defineComponent({ template: "<div>message endpoint</div>" })
  });
  try {
    const catalog = resolveWebSettingsCatalog([settings(rendererId, {
      kind: "message-endpoint-settings",
      surface: "route.adapters",
      slot: "xiaomiHome"
    })]);
    assert.equal(webRenderersAt(catalog, "route.adapters.message-endpoint-settings").length, 1);
    assert.equal(webRenderersAt(catalog, "global.settings.sections").length, 0);
    assert.deepEqual(resolveWebSettingsCatalog([settings(rendererId)]), []);
  } finally {
    dispose();
  }
});
test("system selection settings are owned by the Desktop settings renderer", () => {
  const settingsPage = readFileSync(new URL("./pages/SettingsPage.vue", import.meta.url), "utf8");
  const desktopRenderer = readFileSync(new URL("./components/renderers/DesktopSettingsRenderer.vue", import.meta.url), "utf8");
  assert.doesNotMatch(settingsPage, /desktopSettingsClient|publishInterfaceTheme|selectionReaderSettings|updateSelectionReaderSettings|selectionSpeechEnabled|desktopScreenshotEnabled/);
  assert.match(settingsPage, /TrustedWebRendererHost/);
  assert.match(settingsPage, /pluginCatalogStore\.settingsRenderers/);
  assert.match(desktopRenderer, /selectionReaderSettings/);
  assert.match(desktopRenderer, /updateSelectionReaderSettings/);
  assert.match(desktopRenderer, /selectionSpeechEnabled/);
  assert.match(desktopRenderer, /registerPageSaveAction/);
  assert.match(desktopRenderer, /desktopDirty/);
  assert.match(desktopRenderer, /selectionSpeechDirty/);
  assert.match(desktopRenderer, /!selectionSpeechDirty\.value \|\| selectionSpeechLoaded\.value/);
  assert.match(desktopRenderer, /onBeforeUnmount\(\(\) => \{[\s\S]*unregisterSaveAction\?\.\(\);[\s\S]*unregisterSaveAction = undefined;/);
});
