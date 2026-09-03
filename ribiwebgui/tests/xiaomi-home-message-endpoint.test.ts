import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { translateText } from "../src/i18n/index.js";
import {
  adapterLabel,
  adapterSourceAliases,
  routeKindDefinitionsForGateway
} from "../src/utils/gatewayHelpers.js";

const routeConfigSource = fs.readFileSync(new URL("../src/pages/RouteConfigPage.vue", import.meta.url), "utf8");
const settingsPageSource = fs.readFileSync(new URL("../src/pages/SettingsPage.vue", import.meta.url), "utf8");
const endpointRendererSource = fs.readFileSync(new URL("../src/components/renderers/XiaomiHomeSettingsRenderer.vue", import.meta.url), "utf8");
const authRendererSource = fs.readFileSync(new URL("../src/components/renderers/XiaomiHomeMessageEndpointRenderer.vue", import.meta.url), "utf8");

test("Route message endpoint catalog includes Xiaomi Home as a distinct smart-home input", () => {
  assert.match(routeConfigSource, /title: "智能家居"/);
  assert.match(routeConfigSource, /type: "xiaomiHome", title: "米家 \/ Xiaomi Home"/);
  assert.match(routeConfigSource, /"xiaoai", "xiaomiHome", "rabilink"/);
  assert.match(routeConfigSource, /route\.adapters\.message-endpoint-settings/);
  assert.match(routeConfigSource, /settingsRenderersForMessageEndpoint/);
  assert.match(endpointRendererSource, /此配置属于米家消息端/);
  assert.match(endpointRendererSource, /地址与登录凭据都在当前 Route/);
  assert.match(authRendererSource, /type="password"/);
  assert.match(authRendererSource, /xiaomiHomeAuthClient\.connect\(\{/);
  assert.match(authRendererSource, /accessToken\.value = ""/);
  assert.doesNotMatch(settingsPageSource, /XiaomiHome|xiaomi-home|米家/);
  assert.equal(adapterLabel("xiaomiHome"), "米家 / Xiaomi Home");
  assert.notEqual(adapterLabel("xiaomiHome"), adapterLabel("xiaoai"));
  assert.equal(adapterSourceAliases("xiaomiHome").includes("xiaomi"), false);
  assert.equal(adapterSourceAliases("xiaoai").includes("xiaomi"), true);
});

test("Xiaomi Home rule catalog uses the owner event kind without a Gateway callback", () => {
  const definition = routeKindDefinitionsForGateway().find(item => item.adapter === "xiaomiHome");
  assert.deepEqual(definition?.groups, [{ title: "米家设备事件", routeKinds: ["xiaomi_home_event"] }]);
  assert.match(definition?.note ?? "", /不会启动 Gateway 常驻 adapter/);
});

test("Xiaomi Home UI copy is present in the English catalog", () => {
  assert.equal(translateText("米家 / Xiaomi Home", "en"), "Xiaomi Home");
  assert.equal(translateText("智能家居", "en"), "Smart home");
  assert.equal(translateText("Home Assistant 连接与事件", "en"), "Home Assistant connection and events");
  assert.match(authRendererSource, /本机受保护凭证/);
});
