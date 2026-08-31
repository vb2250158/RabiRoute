import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pageSource = fs.readFileSync(new URL("../src/pages/RouteConfigPage.vue", import.meta.url), "utf8");
const quickSetupSource = fs.readFileSync(new URL("../src/components/QuickSetupDialog.vue", import.meta.url), "utf8");

test("NapCat login stays inside the Route card and exposes the three supported login modes", () => {
  assert.match(pageSource, /QQ 登录控制/);
  assert.match(pageSource, /<v-tab value="quick">快速登录<\/v-tab>/);
  assert.match(pageSource, /<v-tab value="password">密码登录<\/v-tab>/);
  assert.match(pageSource, /<v-tab value="qrcode">扫码登录<\/v-tab>/);
  assert.match(pageSource, /\/api\/message\/napcat-login-panel/);
  assert.match(pageSource, /\/api\/message\/napcat-login-action/);
  assert.match(pageSource, /action: "captcha-login"/);
  assert.match(pageSource, /action: "new-device-login"/);
  assert.match(quickSetupSource, /保存 Route 后，直接在 NapCat 卡片完成快速、密码或扫码登录/);
  for (const source of [pageSource, quickSetupSource]) {
    assert.doesNotMatch(source, /startNapcatAndOpen|openNapcatWebui|打开 NapCat|打开 WebUI|复制 WebUI 登录密钥/);
  }
});
