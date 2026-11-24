import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appSource = fs.readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
const mainSource = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const pluginNavigationSource = fs.readFileSync(new URL("../src/pluginNavigation.ts", import.meta.url), "utf8");
const pluginCatalogStoreSource = fs.readFileSync(new URL("../src/pluginCatalogStore.ts", import.meta.url), "utf8");
const pluginPagesSource = fs.readFileSync(new URL("../src/pluginPages.ts", import.meta.url), "utf8");
const personaSource = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.persona/web/pages/PersonaTemplatePage.vue", import.meta.url), "utf8");
const overviewSource = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.core/web/pages/OverviewPage.vue", import.meta.url), "utf8");
const settingsSource = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.core/web/pages/SettingsPage.vue", import.meta.url), "utf8");
const speechSource = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.speech/web/pages/SpeechServicePage.vue", import.meta.url), "utf8");
const desktopSettingsRendererSource = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.desktop/web/components/renderers/DesktopSettingsRenderer.vue", import.meta.url), "utf8");

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
  assert.match(mainSource, /void refreshWebPluginCatalog\(\)/);
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
  const versionElement = appSource.match(/<div\b([^>]*)>\s*v\{\{\s*store\.meta\.version\s*\}\}\s*<\/div>/);
  assert.ok(versionElement, "The sidebar displays the version supplied by the running Manager.");
  assert.match(versionElement[1], /\bv-if="store\.meta\.version"/, "Unknown versions are not rendered as placeholder releases.");
  assert.match(appSource, /<RoleSourcePicker @select="selectRole" \/>/);
  const picker = fs.readFileSync(new URL("../src/components/RoleSourcePicker.vue", import.meta.url), "utf8");
  assert.match(picker, /:aria-label="t\('选择角色'\)"/);
  assert.match(appSource, /aria-label="选择路由"/);
  assert.doesNotMatch(appSource, /星海消息分诊台/);
  assert.doesNotMatch(appSource, /<span class="section-note">当前航线<\/span>/);
  assert.doesNotMatch(appSource, /<v-chip[^>]*>\{\{ store\.gateways\.length \}\}<\/v-chip>/);
  assert.doesNotMatch(appSource, /label="当前路由"/);
  assert.doesNotMatch(appSource, /:subtitle="item\.raw\.subtitle"/);
});

test("the role list displays catalog roles while host settings live on the Settings page", () => {
  assert.match(overviewSource, /class="app-card glass-card route-card"/);
  assert.match(overviewSource, /roles\.catalog\.map/);
  assert.match(overviewSource, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(overviewSource, /Rabi 实例|目录配置|局域网访问 WebGUI|RabiLink 系统转接服务/);
  assert.match(settingsSource, /class="section-title">目录配置<\/div>/);
  assert.match(settingsSource, /class="section-title small-title">局域网访问 WebGUI<\/div>/);
});

test("role cards show connector icons and use the configured route switch", () => {
  assert.match(overviewSource, /<MessageConnectorIcon\b/);
  assert.match(overviewSource, /:model-value="gw\.enabled !== false"/);
  assert.match(overviewSource, /<v-menu\b/);
  assert.doesNotMatch(overviewSource, /可接收消息|runtime\.running|route-card-selected|roles\.selectedRoleId/);
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
  assert.match(appSource, /refreshWebPluginCatalog\(true\)/);
  assert.match(appSource, /managerEvents\?\.close\(\)/);
});
