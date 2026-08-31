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

test("Route message endpoint catalog includes Xiaomi Home as a distinct smart-home input", () => {
  assert.match(routeConfigSource, /title: "智能家居"/);
  assert.match(routeConfigSource, /type: "xiaomiHome", title: "米家 \/ Xiaomi Home"/);
  assert.match(routeConfigSource, /"xiaoai", "xiaomiHome", "rabilink"/);
  assert.match(routeConfigSource, /\/api\/agent\/xiaomi-home\/health/);
  assert.match(routeConfigSource, /本页不会收集或回显 token/);
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
  assert.match(translateText("授权 token 只放在本机受保护运行环境中；本页不会收集或回显 token。设备控制默认关闭。", "en"), /never collects or displays it/);
});
