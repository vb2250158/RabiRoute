import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appSource = fs.readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
const mainSource = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const pluginNavigationSource = fs.readFileSync(new URL("../src/pluginNavigation.ts", import.meta.url), "utf8");
const pluginCatalogStoreSource = fs.readFileSync(new URL("../src/pluginCatalogStore.ts", import.meta.url), "utf8");
const pluginPagesSource = fs.readFileSync(new URL("../src/pluginPages.ts", import.meta.url), "utf8");
const personaSource = fs.readFileSync(new URL("../src/pages/PersonaTemplatePage.vue", import.meta.url), "utf8");
const overviewSource = fs.readFileSync(new URL("../src/pages/OverviewPage.vue", import.meta.url), "utf8");
const settingsSource = fs.readFileSync(new URL("../src/pages/SettingsPage.vue", import.meta.url), "utf8");
const speechSource = fs.readFileSync(new URL("../src/pages/SpeechServicePage.vue", import.meta.url), "utf8");
const desktopSettingsRendererSource = fs.readFileSync(new URL("../src/components/renderers/DesktopSettingsRenderer.vue", import.meta.url), "utf8");

test("sidebar renders only catalog navigation backed by activated pages", () => {
  const primaryIndex = appSource.indexOf("const navItems = computed");
  const utilityIndex = appSource.indexOf("const utilityNavItems = computed");
  const footerIndex = appSource.indexOf("const footerNavItems = computed");
  const utilityRenderIndex = appSource.indexOf("v-for=\"item in utilityNavItems\"");
  const footerRenderIndex = appSource.indexOf("v-for=\"item in footerNavItems\"");
  const configDirectoryIndex = appSource.indexOf("v-for=\"command in sidebarCommands\"");

  assert.ok(primaryIndex >= 0);
  assert.ok(utilityIndex > primaryIndex);
  assert.ok(footerIndex > utilityIndex);
  assert.ok(utilityRenderIndex > footerIndex);
  assert.ok(footerRenderIndex > utilityRenderIndex);
  assert.ok(configDirectoryIndex > footerRenderIndex);
  assert.match(mainSource, /await pluginCatalogStore\.refresh\(\)/);
  assert.match(pluginCatalogStoreSource, /pluginCatalogClient\.readWeb\(\)/);
  assert.match(pluginCatalogStoreSource, /resolveWebPageCatalog/);
  assert.match(pluginCatalogStoreSource, /resolveWebThemeCatalog/);
  assert.match(pluginNavigationSource, /isWebNavigationPageActive/);
  assert.match(pluginPagesSource, /webPageRendererRegistry/);
  assert.match(personaSource, /personaSecondaryNavItems/);
  assert.match(appSource, /store\.openQuickSetup/);
  assert.match(appSource, /store\.meta\.githubUrl/);
  assert.doesNotMatch(appSource, /route-picker-status|selectedRuntimeLabel|selectedGatewayAdapters/);
});

test("sidebar brand shows only the version and route picker has no count or explanatory label", () => {
  assert.match(appSource, /<div class="section-note">v\{\{ store\.meta\.version \}\}<\/div>/);
  assert.match(appSource, /aria-label="选择航线"/);
  assert.doesNotMatch(appSource, /星海消息分诊台/);
  assert.doesNotMatch(appSource, /<span class="section-note">当前航线<\/span>/);
  assert.doesNotMatch(appSource, /<v-chip[^>]*>\{\{ store\.gateways\.length \}\}<\/v-chip>/);
  assert.doesNotMatch(appSource, /label="当前路由"/);
  assert.doesNotMatch(appSource, /:subtitle="item\.raw\.subtitle"/);
});

test("console is route-card-only while host settings live on the Settings page", () => {
  assert.match(overviewSource, /class="app-card glass-card route-card"/);
  assert.doesNotMatch(overviewSource, /Rabi 实例|目录配置|局域网访问 WebGUI|RabiLink 系统转接服务/);
  assert.match(settingsSource, /class="section-title">Rabi 实例<\/div>/);
  assert.match(settingsSource, /class="section-title">目录配置<\/div>/);
  assert.match(settingsSource, /class="section-title small-title">局域网访问 WebGUI<\/div>/);
});

test("Route cards present only the persisted enabled state", () => {
  const labelStart = overviewSource.indexOf("function gatewayRuntimeLabel");
  const colorStart = overviewSource.indexOf("function gatewayRuntimeColor");
  const label = overviewSource.slice(labelStart, colorStart);
  const color = overviewSource.slice(colorStart, overviewSource.indexOf("</script>"));
  assert.match(label, /"已禁用"/);
  assert.match(label, /"已启用"/);
  assert.doesNotMatch(label, /runtime\.running|运行中|已停止|启用中|禁用中/);
  assert.doesNotMatch(color, /runtime\.running/);
});

test("system selection settings render through the trusted Desktop renderer on Settings", () => {
  assert.match(settingsSource, /TrustedWebRendererHost/);
  assert.doesNotMatch(settingsSource, /selectionSpeechEnabled|selectionSpeechAdvanced|selectionSpeechModel/);
  assert.match(desktopSettingsRendererSource, /开启滑词菜单/);
  assert.match(desktopSettingsRendererSource, /small-title">滑词朗读/);
  assert.match(desktopSettingsRendererSource, /系统级截图/);
  assert.match(desktopSettingsRendererSource, /Windows 登录启动/);
  assert.match(desktopSettingsRendererSource, /themeOptions/);
  assert.match(desktopSettingsRendererSource, /option\.webResourceId/);
  assert.match(desktopSettingsRendererSource, /selectionSpeechAdvanced/);
  assert.match(desktopSettingsRendererSource, /desktopScreenshotShortcut/);
  assert.match(desktopSettingsRendererSource, /desktopAutostart/);
  assert.doesNotMatch(speechSource, /selectionSpeechEnabled|selectionSpeechAdvanced|selectionSpeechModel/);
});


test("WebGUI refreshes plugin contributions from Manager events", () => {
  assert.match(appSource, /managerEventSource\("\/api\/events"\)/);
  assert.match(appSource, /addEventListener\("plugin_catalog_changed"/);
  assert.match(appSource, /pluginCatalogStore\.refresh\(\)/);
  assert.match(appSource, /managerEvents\?\.close\(\)/);
});
