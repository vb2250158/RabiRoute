import assert from "node:assert/strict";
import test from "node:test";
import { deviceSystem, deviceSystemIcon, deviceSystemName } from "../../src/plugins/io.rabiroute.manager.core/web/computer/deviceSystem";
import { phoneDeepLink } from "../../src/plugins/io.rabiroute.manager.core/web/computer/phoneDevice";

test("saved phone links resolve across both device-control layouts", () => {
  assert.equal(phoneDeepLink({ phoneId: "new-phone", deviceType: "phone", deviceId: "old-phone" }), "new-phone");
  assert.equal(phoneDeepLink({ deviceType: "phone", deviceId: "old-phone" }), "old-phone");
  assert.equal(phoneDeepLink({ deviceId: "computer" }), "");
  assert.equal(phoneDeepLink({ deviceType: "phone", deviceId: ["ambiguous"] }), "");
});

test("an advertised platform decides the system before any name guess", () => {
  assert.equal(deviceSystem({ platform: "win32-x64" }), "windows");
  assert.equal(deviceSystem({ platform: "win32" }), "windows");
  assert.equal(deviceSystem({ platform: "darwin-arm64" }), "macos");
  assert.equal(deviceSystem({ platform: "linux-x64" }), "linux");
  assert.equal(deviceSystem({ platform: "win32-x64", name: "打包机Mac" }), "windows");
});

test("a phone reports no platform, so its own label decides and Android is the fallback", () => {
  assert.equal(deviceSystem({ deviceKind: "phone", name: "Android 手机" }), "android");
  assert.equal(deviceSystem({ deviceKind: "phone", name: "我的 iPhone" }), "ios");
  assert.equal(deviceSystem({ deviceKind: "phone", deviceModel: "iPad Pro" }), "ios");
  assert.equal(deviceSystem({ deviceKind: "phone", name: "我的手机" }), "android");
});

test("an unreported desktop stays unknown instead of borrowing a mobile system", () => {
  assert.equal(deviceSystem({}), "unknown");
  assert.equal(deviceSystem({ name: "打包机Mac" }), "macos");
  assert.equal(deviceSystem({ name: "测试机 | Review与QA" }), "unknown");
  assert.equal(deviceSystemName({}), "");
});

test("every system maps to its own icon", () => {
  assert.equal(deviceSystemIcon({ platform: "win32" }), "mdi-microsoft-windows");
  assert.equal(deviceSystemIcon({ platform: "darwin" }), "mdi-apple");
  assert.equal(deviceSystemIcon({ platform: "linux" }), "mdi-linux");
  assert.equal(deviceSystemIcon({ deviceKind: "phone" }), "mdi-android");
  assert.equal(deviceSystemIcon({ deviceKind: "phone", name: "iPad" }), "mdi-apple-ios");
  assert.equal(deviceSystemIcon({}), "mdi-monitor");
  assert.equal(deviceSystemName({ platform: "linux" }), "Linux");
  assert.equal(deviceSystemName({ platform: "darwin" }), "Mac");
});
