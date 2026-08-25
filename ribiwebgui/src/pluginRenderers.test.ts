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

test("built-in settings and status renderers use the trusted registration API", () => {
  assert.ok(registeredWebSettingsRenderers().some(renderer => (
    renderer.instanceId === "manager:desktop"
    && renderer.pluginId === "rabi.manager.base"
    && renderer.rendererId === "builtin.desktop-settings.v1"
  )));
  assert.ok(registeredWebStatusRenderers().some(renderer => (
    renderer.instanceId === "manager:speech"
    && renderer.pluginId === "rabi.manager.base"
    && renderer.rendererId === "builtin.speech-status.v1"
  )));
  assert.ok(registeredWebStatusRenderers().some(renderer => (
    renderer.instanceId === "manager:performance"
    && renderer.pluginId === "rabi.manager.base"
    && renderer.rendererId === "builtin.performance-status.v1"
  )));
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
  assert.throws(() => registerTrustedWebStatusRenderer({
    instanceId: "manager:desktop",
    pluginId: "rabi.manager.base",
    rendererId: "builtin.desktop-settings.v1",
    placementId: "trusted.status.placement",
    allowedSlots: ["trusted"],
    queryId: "trusted.status",
    loader: async () => defineComponent({ template: "<div />" })
  }), /already registered/);
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
