import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { WebPluginCatalog, WebPluginCatalogPlugin } from "../src/pluginCatalogClient";
import {
  availableWebContributions,
  resolveWebContributionVisibility
} from "../src/pluginContributions";

const pluginId = "builtin:manager/test";
const activePlugin: WebPluginCatalogPlugin = {
  instanceId: "manager:test",
  pluginId,
  status: "active",
  manifest: {
    id: pluginId,
    hosts: ["manager", "web", "desktop"],
    capabilities: ["plugin.unrelated-capability"]
  }
};

function catalog(
  contributions: readonly unknown[],
  plugins: readonly WebPluginCatalogPlugin[] = [activePlugin]
): WebPluginCatalog {
  return {
    schemaVersion: 2,
    host: "web",
    revision: { plugins: 1, contributions: 1 },
    plugins,
    contributions
  };
}

function desktopSettings(overrides: Record<string, unknown> = {}) {
  return {
    kind: "settings-section",
    surface: "shared.settings",
    id: "desktop-settings",
    instanceId: "manager:test",
    pluginId,
    hosts: ["web", "desktop"],
    slot: "desktop",
    rendererId: "builtin.desktop-settings.v1",
    schemaId: "desktop.settings.v1",
    readCommandId: "manager.desktop-settings.read",
    writeCommandId: "manager.desktop-settings.write",
    ...overrides
  };
}

function speechStatus(overrides: Record<string, unknown> = {}) {
  return {
    kind: "status-card",
    surface: "shared.status",
    id: "speech-status",
    instanceId: "manager:test",
    pluginId,
    hosts: ["web", "desktop"],
    slot: "runtime-status",
    queryId: "manager.speech-status",
    rendererId: "builtin.speech-status.v1",
    ...overrides
  };
}

function performanceStatus(overrides: Record<string, unknown> = {}) {
  return {
    kind: "status-card",
    surface: "shared.status",
    id: "performance-status",
    instanceId: "manager:test",
    pluginId,
    hosts: ["web", "desktop"],
    slot: "runtime-status",
    queryId: "manager.performance-status",
    rendererId: "builtin.performance-status.v1",
    ...overrides
  };
}

test("controlled Web contributions expose only registered renderer, query, schema, and command contracts", () => {
  const contributions = availableWebContributions(catalog([
    desktopSettings(),
    speechStatus(),
    performanceStatus()
  ]));

  assert.deepEqual(resolveWebContributionVisibility(contributions, "ready"), {
    desktopSettings: true,
    speechStatus: true,
    performanceStatus: true
  });

  const unknownContracts = availableWebContributions(catalog([
    desktopSettings({ rendererId: "plugin.desktop-settings.v2" }),
    desktopSettings({ schemaId: "plugin.desktop.v2" }),
    desktopSettings({ readCommandId: "plugin.desktop.read" }),
    desktopSettings({ writeCommandId: "plugin.desktop.write" }),
    speechStatus({ queryId: "plugin.speech-status" }),
    speechStatus({ rendererId: "plugin.speech-status.v2" }),
    performanceStatus({ queryId: "plugin.performance-status" }),
    performanceStatus({ rendererId: "plugin.performance-status.v2" })
  ]));

  assert.deepEqual(resolveWebContributionVisibility(unknownContracts, "ready"), {
    desktopSettings: false,
    speechStatus: false,
    performanceStatus: false
  });
});

test("requiredCapabilities use the fixed Web host registry instead of plugin manifest capabilities", () => {
  const supported = availableWebContributions(catalog([
    speechStatus({ requiredCapabilities: ["web.status.speech"] })
  ]));
  assert.equal(resolveWebContributionVisibility(supported, "ready").speechStatus, true);

  const unrelatedManifestCapability = availableWebContributions(catalog([
    speechStatus({ requiredCapabilities: ["plugin.unrelated-capability"] })
  ]));
  assert.equal(unrelatedManifestCapability.length, 0);

  const missingCapability = availableWebContributions(catalog([
    speechStatus({ requiredCapabilities: ["web.status.unknown"] })
  ]));
  assert.equal(missingCapability.length, 0);

  const invalidCapabilityList = availableWebContributions(catalog([
    speechStatus({ requiredCapabilities: ["web.status.speech", "web.status.speech"] })
  ]));
  assert.equal(invalidCapabilityList.length, 0);
});

test("contributions require an active matching owner whose manifest supports Web", () => {
  assert.equal(availableWebContributions(catalog(
    [speechStatus()],
    [{ ...activePlugin, status: "failed" }]
  )).length, 0);
  assert.equal(availableWebContributions(catalog([
    speechStatus({ pluginId: "builtin:manager/other" })
  ])).length, 0);
  assert.equal(availableWebContributions(catalog(
    [speechStatus()],
    [{ ...activePlugin, pluginId: "builtin:manager/other" }]
  )).length, 0);
  assert.equal(availableWebContributions(catalog(
    [speechStatus()],
    [{ ...activePlugin, manifest: { ...activePlugin.manifest, hosts: ["manager", "desktop"] } }]
  )).length, 0);
});

test("the first unavailable catalog keeps only the desktop recovery settings", () => {
  assert.deepEqual(resolveWebContributionVisibility(null, "idle"), {
    desktopSettings: false,
    speechStatus: false,
    performanceStatus: false
  });
  assert.deepEqual(resolveWebContributionVisibility(null, "loading"), {
    desktopSettings: false,
    speechStatus: false,
    performanceStatus: false
  });
  assert.deepEqual(resolveWebContributionVisibility(null, "unavailable"), {
    desktopSettings: true,
    speechStatus: false,
    performanceStatus: false
  });
  assert.deepEqual(resolveWebContributionVisibility([], "ready"), {
    desktopSettings: false,
    speechStatus: false,
    performanceStatus: false
  });
});

test("pages hide only controlled summary blocks and keep existing API clients", () => {
  const settings = fs.readFileSync(new URL("../src/pages/SettingsPage.vue", import.meta.url), "utf8");
  const speech = fs.readFileSync(new URL("../src/pages/SpeechServicePage.vue", import.meta.url), "utf8");
  const performance = fs.readFileSync(new URL("../src/pages/PerformancePage.vue", import.meta.url), "utf8");

  assert.match(settings, /v-if="desktopSettingsVisible"/);
  assert.match(settings, /desktopSettingsLoadPromise/);
  assert.match(settings, /desktopSettingsHydrating/);
  assert.match(settings, /if \(desktopSettingsLoadPromise\) return desktopSettingsLoadPromise/);
  assert.match(settings, /desktopSettingsClient\.read\(\)/);
  assert.match(settings, /desktopSettingsClient\.update\(/);
  assert.match(speech, /v-if="speechStatusVisible" class="speech-status-grid"/);
  assert.match(speech, /releaseSpeech = await speech\.acquire\(\)/);
  assert.match(speech, /await syncRuntimeUiFromStore\(\)/);
  assert.match(performance, /v-if="performanceStatusVisible" class="performance-grid performance-overview"/);
  assert.match(performance, /loadPerformanceSummary\(rangeMs\.value\)/);
  assert.match(performance, /loadPerformanceConfig\(\)/);
  assert.match(performance, /managerEventSource\("\/api\/performance\/events"\)/);
  assert.doesNotMatch(speech, /pluginContributionLifecycle|createVisibilityLifecycle/);
  assert.doesNotMatch(performance, /pluginContributionLifecycle|createVisibilityLifecycle/);
});
