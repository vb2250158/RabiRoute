import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPackageStaging } from "./Build-RabiLinkAiuiPackage.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const relayBaseUrl = String(process.env.RABILINK_E2E_RELAY_URL || "").trim().replace(/\/+$/, "");
const token = String(process.env.RABILINK_E2E_TOKEN || "").trim();
const reportPath = path.join(projectRoot, "dist", "device-status-e2e.json");

assert.ok(relayBaseUrl, "RABILINK_E2E_RELAY_URL is required.");
assert.ok(token, "RABILINK_E2E_TOKEN is required.");

const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-aiui-device-e2e-"));
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function createPageInstance(pageModule) {
  const page = pageModule.default;
  assert.ok(page && typeof page === "object", "Compiled page must export a page object.");
  return {
    ...page,
    data: JSON.parse(JSON.stringify(page.data || {})),
    setData(patch = {}) {
      this.data = { ...this.data, ...patch };
    }
  };
}

function installNetworkWxMock() {
  const mockPath = path.join(stagingRoot, "test-mocks", "wx.js");
  fs.mkdirSync(path.dirname(mockPath), { recursive: true });
  fs.writeFileSync(mockPath, `
const storage = new Map();
const wx = {
  getStorageSync(key) { return storage.get(key) || {}; },
  setStorageSync(key, value) { storage.set(key, value); },
  getBatteryInfoSync() { return {}; },
  showToast() {},
  showModal(options = {}) {
    if (typeof options.success === "function") options.success({ confirm: false, cancel: true });
  },
  request(options = {}) {
    fetch(options.url, {
      method: options.method || "GET",
      headers: options.header || {},
      body: options.data === undefined ? undefined : JSON.stringify(options.data)
    }).then(async (response) => {
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
      options.success?.({ statusCode: response.status, data });
    }).catch((error) => options.fail?.({ errMsg: error?.message || String(error) }));
  }
};
export default wx;
`, "utf8");

  const pagePath = path.join(stagingRoot, "pages", "home", "index.js");
  const source = fs.readFileSync(pagePath, "utf8")
    .replace(/import\s+([A-Za-z_$][\w$]*)\s+from\s+"wx";/g, 'import $1 from "../../test-mocks/wx.js";');
  fs.writeFileSync(pagePath, source, "utf8");
}

try {
  await buildPackageStaging(stagingRoot);
  installNetworkWxMock();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "ROKID-DEVICE-STATUS-E2E" }
  });

  const pageUrl = `${pathToFileURL(path.join(stagingRoot, "pages", "home", "index.js")).href}?run=${Date.now()}`;
  const pageModule = await import(pageUrl);
  const page = createPageInstance(pageModule);
  page.onLoad({ token, mode: "transcription" });
  page.setData({ relayBaseUrl });

  const resolved = await page.refreshBatteryStatus();
  assert.equal(resolved, true, "The compiled AIUI page must resolve the live Relay device status.");
  assert.equal(page.data.batteryAvailable, true);
  assert.equal(page.data.batterySource, "relay-cxr");
  assert.match(page.data.batteryText, /^\d{1,3}%$/);

  const report = {
    checkedAt: new Date().toISOString(),
    ok: true,
    source: page.data.batterySource,
    batteryLevel: page.data.batteryLevel,
    charging: page.data.batteryCharging,
    batteryText: page.data.batteryText,
    statusLabel: page.data.batteryStatusLabel,
    compiledInkPage: true,
    tokenStored: false
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  page.onUnload();
  console.log(`AIUI live device-status E2E passed: ${report.batteryText}, charging=${report.charging}.`);
} finally {
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else delete globalThis.navigator;
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}
