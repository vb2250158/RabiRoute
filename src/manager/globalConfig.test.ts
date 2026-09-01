import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RabiGlobalConfigStore } from "./globalConfig.js";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-global-config-"));
}

test("RabiLink Relay uses an explicit global enabled switch", () => {
  const store = new RabiGlobalConfigStore(tempRoot());
  assert.equal(store.read().rabiLinkRelay.enabled, false);
  assert.deepEqual(store.read().webguiLan, { enabled: false, accessToken: "" });
  assert.deepEqual(store.read().performance, {
    enabled: false,
    sampleIntervalMs: 5000,
    retentionHours: 48,
    maxDiskMb: 256,
    slowOperationMs: 2000
  });
  assert.equal(store.read().rabiLinkRelay.speechProxyEnabled, false);
  assert.equal(store.read().rabiLinkRelay.speechServiceUrl, "http://127.0.0.1:8781");

  const configuredButOff = store.patch({
    rabiLinkRelay: {
      enabled: false,
      url: "https://relay.example.test",
      token: "test-token",
      deviceId: "pc-a"
    }
  });
  assert.equal(configuredButOff.rabiLinkRelay.enabled, false);

  const enabled = store.patch({ rabiLinkRelay: { enabled: true } });
  assert.equal(enabled.rabiLinkRelay.enabled, true);
});

test("LAN WebGUI access is persisted in the Rabi PC global config", () => {
  const store = new RabiGlobalConfigStore(tempRoot());
  const configured = store.patch({ webguiLan: { enabled: true, accessToken: "lan-secret" } });
  assert.deepEqual(configured.webguiLan, { enabled: true, accessToken: "lan-secret" });
  assert.deepEqual(new RabiGlobalConfigStore(store.rootDir).read().webguiLan, configured.webguiLan);
});

test("performance monitoring settings are normalized and persisted", () => {
  const store = new RabiGlobalConfigStore(tempRoot());
  const configured = store.patch({
    performance: {
      enabled: true,
      sampleIntervalMs: 100,
      retentionHours: 9999,
      maxDiskMb: 1,
      slowOperationMs: 20
    }
  });
  assert.deepEqual(configured.performance, {
    enabled: true,
    sampleIntervalMs: 1000,
    retentionHours: 720,
    maxDiskMb: 16,
    slowOperationMs: 100
  });
  assert.deepEqual(new RabiGlobalConfigStore(store.rootDir).read().performance, configured.performance);
});

test("legacy Relay config without enabled keeps its previous automatic behavior", () => {
  const rootDir = tempRoot();
  const configPath = path.join(rootDir, "data", "Config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    rabiGuid: "legacy-guid",
    rabiName: "Legacy PC",
    rabiLinkRelay: {
      url: "https://relay.example.test",
      token: "legacy-token",
      deviceId: "legacy-pc",
      claimWaitMs: 60000,
      replyIdleTimeoutMs: 60000
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  }, null, 2), "utf8");

  const config = new RabiGlobalConfigStore(rootDir).read();
  assert.equal(config.rabiLinkRelay.enabled, true);
});

test("request-time reads use the published memory snapshot until an explicit reload", () => {
  const rootDir = tempRoot();
  const store = new RabiGlobalConfigStore(rootDir);
  const published = store.patch({ rabiName: "Published PC" });
  const external = {
    ...published,
    rabiName: "External PC",
    updatedAt: "2026-09-01T00:00:00.000Z"
  };
  fs.writeFileSync(store.configPath, `${JSON.stringify(external, null, 2)}\n`, "utf8");

  assert.equal(store.read().rabiName, "Published PC");
  assert.equal(store.reload().rabiName, "External PC");

  fs.rmSync(store.configPath);
  assert.equal(store.read().rabiName, "External PC");
  assert.equal(fs.existsSync(store.configPath), false);
});
