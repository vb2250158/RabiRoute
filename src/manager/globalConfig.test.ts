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
