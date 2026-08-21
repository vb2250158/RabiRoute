import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appSource = fs.readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
const pluginNavigationSource = fs.readFileSync(new URL("../src/pluginNavigation.ts", import.meta.url), "utf8");
const pluginCatalogStoreSource = fs.readFileSync(new URL("../src/pluginCatalogStore.ts", import.meta.url), "utf8");
const personaSource = fs.readFileSync(new URL("../src/pages/PersonaTemplatePage.vue", import.meta.url), "utf8");
const overviewSource = fs.readFileSync(new URL("../src/pages/OverviewPage.vue", import.meta.url), "utf8");
const settingsSource = fs.readFileSync(new URL("../src/pages/SettingsPage.vue", import.meta.url), "utf8");
const speechSource = fs.readFileSync(new URL("../src/pages/SpeechServicePage.vue", import.meta.url), "utf8");

test("sidebar keeps Route pages above utilities and renders catalog footer entries", () => {
  const primaryIndex = appSource.indexOf("const navItems = computed");
  const utilityIndex = appSource.indexOf("const utilityNavItems = computed");
  const footerIndex = appSource.indexOf("const footerNavItems = computed");
  const utilityRenderIndex = appSource.indexOf("v-for=\"item in utilityNavItems\"");
  const footerRenderIndex = appSource.indexOf("v-for=\"item in footerNavItems\"");
  const configDirectoryIndex = appSource.indexOf("store.openConfigFile('manager')");

  assert.ok(primaryIndex >= 0);
  assert.ok(utilityIndex > primaryIndex);
  assert.ok(footerIndex > utilityIndex);
  assert.ok(utilityRenderIndex > footerIndex);
  assert.ok(footerRenderIndex > utilityRenderIndex);
  assert.ok(configDirectoryIndex > footerRenderIndex);
  assert.match(appSource, /pluginCatalogStore\.refresh\(\)/);
  assert.match(pluginCatalogStoreSource, /pluginCatalogClient\.readWeb\(\)/);
  assert.match(pluginCatalogStoreSource, /contributions\.value = null/);
  assert.match(pluginNavigationSource, /id: "settings"[^\n]+routeId: "global\.settings"/);
  assert.match(pluginNavigationSource, /id: "docs"[^\n]+routeId: "global\.docs"[^\n]+slot: "footer"/);
  assert.match(pluginNavigationSource, /id: "persona-sync"[^\n]+routeId: "route\.persona-sync"[^\n]+slot: "persona-secondary"/);
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

test("selected-text reading, screenshots, and login startup stay on Settings", () => {
  assert.match(settingsSource, /开启滑词菜单/);
  assert.match(settingsSource, /small-title">滑词朗读/);
  assert.match(settingsSource, /系统级截图/);
  assert.match(settingsSource, /Windows 登录启动/);
  assert.match(settingsSource, /RabiRoute 在 Windows 中提供截图、滑词和登录启动设置。/);
  assert.match(settingsSource, /登录 Windows 后自动启动 RabiRoute Desktop；后台运行时保留系统托盘入口。/);
  assert.doesNotMatch(settingsSource, /Manager 仍按自己的运行开关管理/);
  assert.match(settingsSource, /selectionSpeechAdvanced/);
  assert.match(settingsSource, /desktopScreenshotShortcut/);
  assert.match(settingsSource, /desktopAutostart/);
  assert.doesNotMatch(speechSource, /selectionSpeechEnabled|selectionSpeechAdvanced|selectionSpeechModel/);
  assert.doesNotMatch(speechSource, /划词朗读模型/);
});
