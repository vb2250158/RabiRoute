import { registerSourcePluginTranslations } from "./plugin-translation-test-host";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { translateText } from "../src/i18n/index.js";
import { openXiaomiHomeRecordings } from "../src/xiaomiHomeSettingsClient.js";
import {
  adapterLabel,
  adapterSourceAliases,
  routeKindDefinitionsForGateway
} from "../src/utils/gatewayHelpers.js";
import {
  HOME_ASSISTANT_AUTHENTICATION_DOCS_URL,
  HOME_ASSISTANT_INSTALLATION_URL,
  HOME_ASSISTANT_XIAOMI_HOME_DOCS_URL,
  homeAssistantEndpointPresentation,
  homeAssistantLoginUrl,
  homeAssistantProfileUrl
} from "../src/xiaomiHomeCredentialHelp.js";

const disposePluginTranslations = await registerSourcePluginTranslations();
test.after(disposePluginTranslations);

test("managed HA uses the actual deployment address for links while preserving the credential origin", () => {
  const deployment = { config: { mode: "haos" as const }, state: "ready" as const, baseUrl: "http://127.0.0.1:43123" };
  const value = homeAssistantEndpointPresentation(deployment, "http://127.0.0.1:8123", "http://127.0.0.1:8123");
  assert.equal(value.address, "http://127.0.0.1:43123");
  assert.equal(value.loginUrl, "http://127.0.0.1:43123/");
  assert.equal(value.profileUrl, "http://127.0.0.1:43123/profile/security");
  assert.equal(value.credentialBaseUrl, "http://127.0.0.1:8123");
  assert.equal(value.serviceReady, true);
  assert.equal(homeAssistantEndpointPresentation(deployment, "https://unrelated.example", "http://127.0.0.1:8123").credentialBaseUrl, "http://127.0.0.1:8123");
  assert.equal(homeAssistantEndpointPresentation({ ...deployment, state: "starting" }, "http://127.0.0.1:8123", "http://127.0.0.1:8123").serviceReady, false);
  const missing = homeAssistantEndpointPresentation({ ...deployment, state: "starting", baseUrl: "" }, "http://127.0.0.1:8123", "http://127.0.0.1:8123");
  assert.equal(missing.address, "");
  assert.equal(missing.loginUrl, "");
  assert.equal(missing.serviceReady, false);
  assert.equal(homeAssistantEndpointPresentation({ ...deployment, baseUrl: "javascript:alert(1)" }, "http://127.0.0.1:8123", "http://127.0.0.1:8123").serviceReady, false);
  assert.equal(homeAssistantEndpointPresentation(undefined, "http://127.0.0.1:8123", "http://127.0.0.1:8123").serviceReady, false);
});

test("external and Docker endpoints retain manual address and matching readiness", () => {
  for (const mode of ["external", "docker"] as const) {
    const deployment = { config: { mode }, state: "ready" as const, baseUrl: "http://192.168.1.10:8123" };
    const same = homeAssistantEndpointPresentation(deployment, "http://192.168.1.10:8123", "http://old.example");
    assert.equal(same.credentialBaseUrl, "http://192.168.1.10:8123");
    assert.equal(same.serviceReady, true);
    const edited = homeAssistantEndpointPresentation(deployment, "http://192.168.1.11:8123", "http://old.example");
    assert.equal(edited.address, "http://192.168.1.11:8123");
    assert.equal(edited.serviceReady, false);
  }
});

const routeConfigSource = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.message-adapter-control/web/pages/RouteConfigPage.vue", import.meta.url), "utf8");
const settingsPageSource = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.core/web/pages/SettingsPage.vue", import.meta.url), "utf8");
const endpointRendererSource = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.xiaomi-home/web/components/renderers/XiaomiHomeSettingsRenderer.vue", import.meta.url), "utf8");
const authRendererSource = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.xiaomi-home/web/components/renderers/XiaomiHomeMessageEndpointRenderer.vue", import.meta.url), "utf8");

test("recordings open on the local Xiaomi owner role, regardless of the displayed role", async t => {
  let ownerRole = "CameraRecorder";
  t.mock.method(globalThis, "fetch", async () => Response.json({ code: 0, data: { settings: { agentRoleId: ownerRole } } }));
  const opened: string[] = [];
  const displayedRole = "AnotherRole";
  await openXiaomiHomeRecordings(async roleId => { opened.push(roleId); });
  assert.deepEqual(opened, ["CameraRecorder"]);
  assert.notEqual(opened[0], displayedRole);
  ownerRole = "";
  await assert.rejects(openXiaomiHomeRecordings(async roleId => { opened.push(roleId); }), /米家设置中配置事件接收角色/);
  assert.deepEqual(opened, ["CameraRecorder"]);
});

test("Route message endpoint catalog includes Xiaomi Home as a distinct smart-home input", () => {
  const pluginSource = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.xiaomi-home/manager.mjs", import.meta.url), "utf8");
  assert.match(pluginSource, /"group":\s*\{[\s\S]*?"title": "设备与自定义接入"/);
  assert.match(pluginSource, /"endpointType": "xiaomiHome"/);
  assert.match(pluginSource, /"title": "米家 \/ Xiaomi Home"/);
  assert.match(routeConfigSource, /messageEndpointCatalog\(pluginCatalogStore.settingsRenderers.value\)/);
  assert.doesNotMatch(routeConfigSource, /type: "xiaoai", title:/);
  const quickSetupSource = fs.readFileSync(new URL("../src/components/QuickSetupDialog.vue", import.meta.url), "utf8");
  assert.doesNotMatch(quickSetupSource, /type: "xiaoai", title:/);
  assert.equal(routeKindDefinitionsForGateway().some((entry) => entry.adapter === "xiaoai"), false);
  assert.match(routeConfigSource, /route\.adapters\.message-endpoint-settings/);
  assert.match(routeConfigSource, /settingsRenderersForMessageEndpoint/);
  assert.match(endpointRendererSource, /事件、设备控制与录像/);
  assert.match(authRendererSource, /type="password"/);
  assert.match(authRendererSource, /xiaomiHomeAuthClient\.connect\(\{/);
  assert.match(authRendererSource, /endpoint\.value\.credentialBaseUrl/);
  assert.match(authRendererSource, /v-if="managed"[\s\S]*:model-value="endpoint.address"[\s\S]*readonly/);
  assert.match(authRendererSource, /accessToken\.value = ""/);
  assert.match(authRendererSource, /不是小米账号密码或设备 token/);
  assert.match(authRendererSource, /打开 Home Assistant/);
  assert.match(authRendererSource, /打开令牌管理/);
  assert.match(authRendererSource, /:disabled="!loginUrl \|\| !serviceReady"/);
  assert.match(authRendererSource, /:disabled="!profileUrl \|\| !serviceReady"/);
  assert.doesNotMatch(authRendererSource, /v-if="loginUrl"/);
  assert.doesNotMatch(authRendererSource, /v-if="profileUrl"/);
  assert.match(authRendererSource, /先填写有效的 Home Assistant 地址/);
  assert.match(authRendererSource, /怎样获取令牌？/);
  assert.match(authRendererSource, /v-expansion-panels/);
  assert.doesNotMatch(authRendererSource, /连接前准备两项/);
  assert.doesNotMatch(settingsPageSource, /XiaomiHome|xiaomi-home|米家/);
  assert.equal(adapterLabel("xiaomiHome"), "米家 / Xiaomi Home");
  assert.notEqual(adapterLabel("xiaomiHome"), adapterLabel("xiaoai"));
  assert.equal(adapterSourceAliases("xiaomiHome").includes("xiaomi"), false);
  assert.equal(adapterSourceAliases("xiaoai").includes("xiaomi"), true);
});

test("Xiaomi Home diagnostics stay beside their owning settings instead of the top dependency panel", () => {
  assert.doesNotMatch(routeConfigSource, /choice\.type === 'xiaomiHome'|choice\.type !== 'xiaomiHome'/);
  const cardSource = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.xiaomi-home/web/messageEndpoints/XiaomiHomeEndpointCard.vue", import.meta.url), "utf8");
  assert.match(cardSource, /XiaomiHomeRendererHost/);
  assert.match(routeConfigSource, /scan: messageScanFor\(choice\.type\)/);
  assert.match(endpointRendererSource, /item\.id === "event-monitor"/);
  assert.match(endpointRendererSource, /aria-label="监听设备事件"/);
  assert.match(endpointRendererSource, /aria-label="设备控制"/);
  assert.match(endpointRendererSource, /aria-label="摄像头事件录像"/);
  assert.match(endpointRendererSource, /检查事件监听/);
  assert.match(endpointRendererSource, /v-if="draft\.eventMonitorEnabled !== snapshot\?\.settings\.eventMonitorEnabled"/);
  assert.match(endpointRendererSource, /v-else-if="!draft\.eventMonitorEnabled"/);
  assert.match(endpointRendererSource, /await props\.context\?\.refreshScan\?\.\(\)/);
  assert.match(authRendererSource, /await props\.context\?\.refreshScan\?\.\(\)/);
  assert.doesNotMatch(endpointRendererSource, /未发现/);
  assert.match(authRendererSource, /stateDetail/);
  assert.match(authRendererSource, /:error-messages="baseUrlError"/);
  assert.match(authRendererSource, /:error-messages="accessTokenError"/);
});

test("Xiaomi Home credential help links only create safe Home Assistant profile URLs", () => {
  assert.equal(homeAssistantLoginUrl("http://homeassistant.local:8123/config?next=1#fragment"), "http://homeassistant.local:8123/");
  assert.equal(homeAssistantProfileUrl("http://homeassistant.local:8123"), "http://homeassistant.local:8123/profile/security");
  assert.equal(homeAssistantProfileUrl("https://ha.example.test/config?next=1#fragment"), "https://ha.example.test/profile/security");
  assert.equal(homeAssistantProfileUrl("javascript:alert(1)"), "");
  assert.equal(homeAssistantProfileUrl("not a url"), "");
  assert.equal(homeAssistantLoginUrl("javascript:alert(1)"), "");
  for (const url of ["https://test-user:fake-password@ha.example.test", "https://test-user@ha.example.test", "https://:fake-password@ha.example.test"]) {
    assert.equal(homeAssistantLoginUrl(url), "");
    assert.equal(homeAssistantProfileUrl(url), "");
  }
  assert.equal(HOME_ASSISTANT_AUTHENTICATION_DOCS_URL, "https://www.home-assistant.io/docs/authentication/");
  assert.equal(HOME_ASSISTANT_INSTALLATION_URL, "https://www.home-assistant.io/installation/");
  assert.equal(HOME_ASSISTANT_XIAOMI_HOME_DOCS_URL, "https://github.com/XiaoMi/ha_xiaomi_home/blob/main/doc/README_zh.md");
});

test("Xiaomi Home rule catalog uses the owner event kind without a Gateway callback", () => {
  const definition = routeKindDefinitionsForGateway().find(item => item.adapter === "xiaomiHome");
  assert.deepEqual(definition?.groups, [{ title: "米家设备事件", routeKinds: ["xiaomi_home_event"] }]);
  assert.match(definition?.note ?? "", /不会启动 Gateway 常驻 adapter/);
});

test("Xiaomi Home UI copy is present in the English catalog", () => {
  assert.equal(translateText("米家 / Xiaomi Home", "en"), "Xiaomi Home");
  assert.equal(translateText("智能家居", "en"), "Smart home");

  assert.equal(translateText("打开 Home Assistant", "en"), "Open Home Assistant");
  assert.equal(translateText("怎样获取令牌？", "en"), "How do I get a token?");
  assert.equal(translateText("先填写有效的 Home Assistant 地址。", "en"), "Enter a valid Home Assistant URL first.");
  assert.match(authRendererSource, /本机受保护凭证/);
});
