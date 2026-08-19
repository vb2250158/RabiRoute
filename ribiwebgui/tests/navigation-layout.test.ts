import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appSource = fs.readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
const overviewSource = fs.readFileSync(new URL("../src/pages/OverviewPage.vue", import.meta.url), "utf8");
const settingsSource = fs.readFileSync(new URL("../src/pages/SettingsPage.vue", import.meta.url), "utf8");
const speechSource = fs.readFileSync(new URL("../src/pages/SpeechServicePage.vue", import.meta.url), "utf8");

test("sidebar keeps Route pages above the utility pages and settings above the guide footer", () => {
  const primaryIndex = appSource.indexOf("const navItems = computed");
  const utilityIndex = appSource.indexOf("const utilityNavItems = computed");
  const utilityRenderIndex = appSource.indexOf("v-for=\"item in utilityNavItems\"");
  const guideIndex = appSource.indexOf('to="/docs"');

  assert.ok(primaryIndex >= 0);
  assert.ok(utilityIndex > primaryIndex);
  assert.ok(utilityRenderIndex > utilityIndex);
  assert.ok(guideIndex > utilityRenderIndex);
  assert.match(appSource, /\{ title: "设置", icon: "mdi-cog-outline", to: "\/settings" \}/);
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
  assert.match(settingsSource, /selectionSpeechAdvanced/);
  assert.match(settingsSource, /desktopScreenshotShortcut/);
  assert.match(settingsSource, /desktopAutostart/);
  assert.doesNotMatch(speechSource, /selectionSpeechEnabled|selectionSpeechAdvanced|selectionSpeechModel/);
  assert.doesNotMatch(speechSource, /划词朗读模型/);
});
